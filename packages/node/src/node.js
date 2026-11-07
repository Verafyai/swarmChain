/**
 * A Verafy Chain node: a mempool of funded contracts, jury coordination, sealer
 * rotation and a block store. A node never calls a model; harnesses do.
 *
 * Every hash, signature, agreement and diff check is from `@verafyharness/core`.
 * @module swarmchain/node
 */
import {
  createIdentity, importIdentity, signMessage, verifyMessage, validate, loadContext, ascHash as hashAsc,
  drawJuryFor, checkCommit, checkRevealRecord, ruleFromRecords, resolveChallenge, seal, canonical,
  createQueueKey, envelopeProblems, queueId, openShare, openContract, openWithKey,
  needsProofs, proofCheck, bondFaults, sha256,
} from '#core'
import { mockVerifier, verifyBundle } from '#prove'
import { BlockStore } from './store.js'
import { ContextStore, fetchContext } from '../../storage/src/index.js'
import { verifyBlock, expectedSealer, challengeProblem, sealTime, GENESIS, BlockRejected } from './verify.js'
import { loadChainConfig, batchParams, thresholdFor, isBatched, closeDecision, closeProblem, costSplit, quote } from './batch.js'

/** The record a sealer signs when it closes a block from the queue: members, and the juries drawn for them. */
export const DRAW_KIND = 'verafy.draw/1'

export class ChainNode {
  /**
   * @param {object} options - node setup.
   * @param {string} options.id - this node's id, such as `node-1`.
   * @param {string} [options.url] - this node's base URL, given to peers as a storage source.
   * @param {string} [options.db] - SQLite path; ':memory:' by default.
   * @param {number} [options.windowMs] - the challenge window that storage holds context through.
   * @param {object} options.jurors - a juror client: `commit(entry, asc)` and `reveal(entry, ascHash)`.
   * @param {(h: string, sources: string[]) => Promise<string>} [options.fetchContent] - fetch context bytes by hash.
   * @param {(event: object) => void} [options.log] - event sink.
   * @param {object | string} [options.identity] - a kept Ed25519 key (identity, KeyObject or PKCS#8 PEM), so a restarted node keeps its id; a fresh key otherwise.
   * @param {object} [options.config] - the chain config (`config/chain.json`, loaded and frozen by default).
   * @param {() => number} [options.now] - this node's clock in ms, for the queue's time rule.
   * @param {object} [options.verifier] - the Verifier (packages/prove) this node runs on L2 proofs; the mock by default.
   * @param {number} [options.proofDeadlineMs] - how long after the reveal round a juror has to attach its proof (default from the chain config).
   */
  constructor({ id, url = '', db = ':memory:', windowMs, jurors, fetchContent = fetchContext, log = () => {}, identity, config = loadChainConfig(), now = Date.now, verifier = mockVerifier(), proofDeadlineMs }) {
    this.id = id
    this.url = url
    this.identity = identity ? importIdentity(identity) : createIdentity()
    this.store = new BlockStore(db)
    this.storage = new ContextStore(this.store.db, { windowMs })
    this.jurors = jurors
    this.fetchContent = fetchContent
    this.log = log
    this.validators = new Map([[id, this.identity.publicKey]])
    this.gossip = { broadcast: async () => [] }
    this.commitments = new Map()
    this.sealing = false
    this.pendingBlocks = new Map()
    this.config = config
    this.params = batchParams(config)
    this.now = now
    // The queue key is X25519, separate from the signing identity. Kept in memory only.
    this.queueKey = createQueueKey()
    this.queueKeys = new Map([[id, this.queueKey.publicKey]])
    /** How this node asks its peers for decryption shares; set by the server or the test network. */
    this.peers = { requestShares: async () => [] }
    this.verifier = verifier
    this.proofDeadlineMs = proofDeadlineMs ?? config.proving.L2.proofDeadlineSeconds.value * 1000
  }

  /** @returns {{id: string, publicKey: string, url: string}} what peers need to verify this node's blocks. */
  get card() {
    return { id: this.id, publicKey: this.identity.publicKey, url: this.url, encryptionKey: this.queueKey.publicKey }
  }

  /**
   * Add a validator node to the sealer rotation.
   * @param {{id: string, publicKey: string}} card - the node's id and key.
   */
  addValidator({ id, publicKey, encryptionKey }) {
    this.validators.set(id, publicKey)
    if (encryptionKey) this.queueKeys.set(id, encryptionKey)
  }

  /**
   * The node set a contract is sealed to, and the shares needed to open it.
   * @returns {{t: number, nodes: {id: string, encryptionKey: string}[]}} the committee.
   */
  committee() {
    const ids = [...this.validators.keys()].sort()
    const missing = ids.filter(i => !this.queueKeys.has(i))
    if (missing.length) throw new Error(`no queue key yet for ${missing.join(', ')}`)
    return { t: thresholdFor(ids.length, this.params.threshold), nodes: ids.map(i => ({ id: i, encryptionKey: this.queueKeys.get(i) })) }
  }

  /**
   * Register a harness. The registration must be signed by the harness's own key.
   * @param {{card: object, url: string, signature: string}} entry - the signed registration.
   */
  registerHarness(entry) {
    const { card, url, signature } = entry ?? {}
    if (!card?.id || !card?.lab || !card?.publicKey) throw new Error('registration needs a card with id, lab and publicKey')
    if (!verifyMessage(card.publicKey, { card, url }, signature)) throw new Error('registration signature does not verify')
    this.store.putHarness({ card, url, signature })
  }

  /** @returns {Map<string, object>} harness id to card. */
  harnessCards() {
    return new Map(this.store.harnesses().map(e => [e.card.id, e.card]))
  }

  /**
   * Accept a funded contract into the mempool. Context bytes are checked against
   * their pins, kept in storage, and stripped from the stored contract. A
   * challenge is a contract in core's `challengeContract` format (it carries
   * `review`), and must name a sealed ruling.
   * @param {object} asc - the contract, with or without context bytes.
   * L2 contracts batch, so they enter only through the encrypted queue (`submitSealed`).
   * @param {{sources?: string[], gossip?: boolean, fromQueue?: boolean}} [options] - places to fetch missing context, whether to gossip it, and whether it was just opened from the queue.
   * @returns {Promise<string>} the contract's hash.
   */
  async submit(asc, { sources = [], gossip = true, fromQueue = false } = {}) {
    const problems = validate(asc)
    if (problems.length) throw new Error(`contract rejected: ${problems.join('; ')}`)
    if (isBatched(asc) && !fromQueue) throw new Error('contract rejected: L2 contracts batch, so they enter through the encrypted queue (POST /queue), not the open mempool')
    if (asc.review) {
      const problem = challengeProblem(asc, id => this.store.ruling(id))
      if (problem) throw new Error(`contract rejected: ${problem}`)
    }
    const h = hashAsc(asc)
    if (this.store.contract(h)) return h
    const filled = { ...asc, context: await Promise.all(asc.context.map(async c => typeof c.content === 'string' ? c : { ...c, content: this.storage.get(c.sha256) ?? await this.fetchContent(c.sha256, sources) })) }
    const loaded = loadContext(filled)
    if (!loaded.ok) throw new Error(`contract rejected: ${loaded.problems.join('; ')}`)
    for (const c of filled.context) this.storage.put(c.content, c.sha256)
    const stripped = { ...asc, context: asc.context.map(({ content, ...meta }) => meta) }
    this.store.addContract(h, stripped)
    this.log({ event: 'contract', node: this.id, asc: asc.id, ascHash: h })
    if (gossip) await this.gossip.broadcast('contract', { asc: stripped, sources: [this.url, ...sources].filter(Boolean) })
    return h
  }

  /**
   * A mempool entry with its context bytes attached from storage.
   * @param {string} h - asc hash.
   * @returns {{entry: object, asc: object} | null} the entry.
   */
  contract(h) {
    const entry = this.store.contract(h)
    if (!entry) return null
    const asc = { ...entry.asc, context: entry.asc.context.map(c => {
      const content = this.storage.get(c.sha256)
      return content === null ? c : { ...c, content }
    }) }
    return { entry, asc }
  }

  /** @returns {object | null} the tip block. */
  tip() {
    return this.store.tip()
  }

  /** @returns {string} the node that must seal the next block. */
  nextSealer() {
    return expectedSealer([...this.validators.keys()], (this.tip()?.height ?? 0) + 1)
  }

  /** The view of the chain that verification reads. */
  #view() {
    return {
      parent: this.tip(),
      validators: this.validators,
      harnesses: this.harnessCards(),
      contract: h => this.contract(h),
      ruling: id => this.store.ruling(id),
      reviews: id => this.store.reviews(id),
      seenCommitment: (h, harness) => this.commitments.get(`${h}:${harness}`),
    }
  }

  /**
   * Verify a block and append it. Throws BlockRejected and changes nothing if any check fails.
   * @param {object} block - the block.
   * @returns {Promise<object>} the block.
   */
  async accept(block) {
    const { rulings, reviews, settlements } = verifyBlock(block, this.#view())
    this.store.append(block, rulings, reviews, () => {
      for (const s of settlements) {
        this.store.settleContract(s.ascHash, s.status, block.hash, s.carried)
        for (const c of s.context) this.storage.retain(c, Date.parse(block.time))
      }
      // Every fault a round records is kept against the harness's bond, for slashing later.
      for (const { ruling } of rulings) for (const f of bondFaults(ruling)) this.store.addFault({ ...f, height: block.height, block: block.hash })
    })
    this.log({ event: 'block', node: this.id, height: block.height, hash: block.hash, sealer: block.sealer })
    return block
  }

  /**
   * The next contract the pool can seat a jury for, oldest first. Contracts whose
   * jury cannot be seated wait.
   * @returns {{entry: object, asc: object, jury: object[]} | null} the contract and its jury.
   */
  nextContract() {
    const seed = this.tip()?.hash ?? GENESIS
    const pool = [...this.store.harnesses()].map(e => ({ ...e.card, entry: e }))
    for (const entry of this.store.contracts()) {
      if (entry.status !== 'pending') continue
      if (isBatched(entry.asc)) continue // L2 contracts seal only in a batch
      if (entry.asc.review && !this.store.ruling(entry.asc.review.ruling)) continue
      try {
        const jury = drawJuryFor(entry.asc, pool, seed)
        return { ...this.contract(entry.ascHash), jury }
      } catch { /* this pool cannot seat it yet */ }
    }
    return null
  }

  /**
   * Seal the next block if it is this node's turn and a contract is waiting.
   * No contract, no block.
   * @returns {Promise<object | null>} the sealed block, or null.
   */
  async sealNext() {
    if (this.sealing || this.nextSealer() !== this.id) return null
    this.sealing = true
    try {
      const block = await this.prepareBlock()
      if (!block) return null
      await this.accept(block)
      await this.gossip.broadcast('block', block)
      return block
    } finally {
      this.sealing = false
    }
  }

  /**
   * Run one jury round and seal its ruling into a block, without appending or
   * gossiping it. No contract, no block.
   * @returns {Promise<object | null>} the sealed block, or null when nothing can be ruled.
   */
  async prepareBlock() {
    const next = this.nextContract()
    if (next) return this.#sealRounds([next])
    return this.#prepareFromQueue()
  }

  /**
   * Run every contract's jury round and seal the rulings into one block.
   * @param {{entry: object, asc: object, jury: object[]}[]} list - contracts and their drawn juries.
   * @returns {Promise<object>} the sealed block.
   */
  async #sealRounds(list) {
    const parent = this.tip()
    const seed = parent?.hash ?? GENESIS
    const rulings = []
    const reviews = []
    for (const { entry, asc, jury } of list) {
      const ruling = await this.#round(asc, entry.ascHash, jury, seed)
      rulings.push(ruling)
      if (asc.review) {
        const review = resolveChallenge(asc, ruling, this.store.ruling(asc.review.ruling).ruling)
        if (review.result !== 'stands') reviews.push(review)
      }
    }
    return seal(parent, rulings, this.signer, { time: sealTime(parent), reviews })
  }

  async #round(asc, h, jury, seed) {
    // Commit round: every juror deliberates and publishes only a commitment.
    const settled = await Promise.allSettled(jury.map(j => this.jurors.commit(j.entry, asc)))
    const commits = []
    settled.forEach((s, i) => {
      const card = jury[i]
      const problem = s.status === 'fulfilled' ? checkCommit(card, s.value, h) : String(s.reason?.message ?? s.reason)
      if (problem) this.log({ event: 'commit-failed', node: this.id, harness: card.id, error: problem })
      else commits.push(s.value)
    })
    for (const c of commits) { this.#noteCommit(h, c); await this.gossip.broadcast('commit', { ascHash: h, commit: c }) }

    // Reveal round opens only after the commit round closes.
    const reveals = []
    for (const c of commits) {
      const card = jury.find(j => j.id === c.harness)
      try {
        const r = await this.jurors.reveal(card.entry, h)
        const problem = checkRevealRecord(card, c, r, h)
        if (problem) { this.log({ event: 'reveal-failed', node: this.id, harness: c.harness, error: problem }); continue }
        reveals.push(r)
        await this.gossip.broadcast('reveal', { ascHash: h, reveal: r })
      } catch (err) {
        this.log({ event: 'reveal-failed', node: this.id, harness: c.harness, error: err.message })
      }
    }

    // L2: after the reveal, each juror attaches its proof hash before the proof deadline.
    // Proving never blocks the commit; the commit and reveal rounds above are the same for every level.
    const proving = needsProofs(asc) ? await this.#proofRound(asc, h, jury, reveals) : {}

    // Core rules from the recorded messages, exactly as every verifier will. A juror
    // that did not commit or reveal, or (L2) whose proof is missing or fails, is not
    // counted and is listed in the round's faults.
    return ruleFromRecords(asc, commits, reveals, { jury, sealer: { id: this.id, kind: 'node' }, seed, ...proving })
  }

  /**
   * The proof round (Part D1). Ask every juror that revealed for its proof
   * record and bundle, in parallel, until the proof deadline. Keep each bundle in
   * the availability layer (this node's storage, off chain), run this node's
   * Verifier on it, and sign a check. Only the records (hashes) and the signed
   * checks go into the ruling.
   */
  async #proofRound(asc, h, jury, reveals) {
    let timer
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('deadline'), this.proofDeadlineMs) })
    const asked = reveals.map(async r => {
      const card = jury.find(j => j.id === r.harness)
      try {
        const got = await Promise.race([this.jurors.proof(card.entry, asc, h), deadline])
        if (got === 'deadline') return this.log({ event: 'proof-missed', node: this.id, harness: r.harness, error: `no proof within ${this.proofDeadlineMs} ms` })
        return { reveal: r, ...got }
      } catch (err) {
        this.log({ event: 'proof-missed', node: this.id, harness: r.harness, error: err.message })
      }
    })
    const got = (await Promise.all(asked)).filter(Boolean)
    clearTimeout(timer)
    const proofRecords = []
    const proofChecks = []
    for (const { reveal, record, bundle } of got) {
      if (!record || record.harness !== reveal.harness) continue
      proofRecords.push(record)
      if (typeof bundle === 'string' && sha256(bundle) === record.proofHash) this.storage.put(bundle, record.proofHash)
      const result = await verifyBundle(this.verifier, asc, record, bundle, reveal.vote)
      if (!result.ok) this.log({ event: 'proof-failed', node: this.id, harness: record.harness, error: result.reason })
      proofChecks.push(proofCheck(this.id, this.identity.privateKey, record, result))
    }
    return { proofRecords, proofChecks }
  }

  // ---- The encrypted queue ------------------------------------------------

  /**
   * Queue a sealed contract (core's `verafy.sealed/1`). The node checks its shape
   * and that it is sealed to this node set with the chain's threshold; it cannot
   * read it. Only the escrow reference and payment metadata are in the clear.
   * @param {object} env - the envelope.
   * @param {{gossip?: boolean}} [options] - whether to gossip it.
   * @returns {Promise<string>} the queue id.
   */
  async submitSealed(env, { gossip = true } = {}) {
    const { t, nodes } = this.committee()
    const problems = envelopeProblems(env, { nodes: nodes.map(n => n.id), t })
    if (problems.length) throw new Error(`sealed contract rejected: ${problems.join('; ')}`)
    const id = queueId(env)
    if (this.store.sealed(id)) return id
    this.store.addSealed(id, env, this.now())
    this.log({ event: 'queued', node: this.id, queueId: id, escrow: env.meta.escrow, assurance: env.meta.jury.assurance ?? 'L0' })
    if (gossip) await this.gossip.broadcast('sealed', { env })
    return id
  }

  /** @returns {{id: string, meta: object, receivedAt: number}[]} queued contracts, oldest first. */
  queueView() {
    return this.store.queue('queued').map(({ id, meta, receivedAt }) => ({ id, meta, receivedAt }))
  }

  /**
   * What the queue would do now: the close decision and the cost split it would seal with.
   * @returns {object} the decision, labeled modeled.
   */
  queueStatus() {
    const d = closeDecision(this.queueView(), { now: this.now(), p: this.params })
    return { queued: this.queueView().length, ...d }
  }

  /**
   * A quote for a contract before it is funded (see batch.js `quote`).
   * @param {object} meta - the contract's clear metadata.
   * @returns {object} the quote.
   */
  quote(meta) {
    return quote(meta, this.queueView(), this.params)
  }

  #pool() {
    return [...this.store.harnesses()].map(e => ({ ...e.card, entry: e }))
  }

  #drawFor(meta, seed) {
    return drawJuryFor({ payment: { jury: meta.jury, maxValuePerVote: meta.maxValuePerVote } }, this.#pool(), seed)
  }

  /**
   * Check a sealer's draw record against this node's own view: signed by the
   * node whose turn it is, seeded by this node's tip, every jury the draw that
   * seed gives, and a close rule that holds here.
   * @param {object} draw - the signed draw record.
   * @returns {string | null} the problem, or null.
   */
  drawProblem(draw) {
    const { signature, ...payload } = draw ?? {}
    if (payload.kind !== DRAW_KIND) return `a draw record is "${DRAW_KIND}"`
    const key = this.validators.get(payload.sealer)
    if (!key || !verifyMessage(key, payload, signature)) return 'draw signature does not verify'
    const tip = this.tip()
    if (payload.height !== (tip?.height ?? 0) + 1) return `draw is for height ${payload.height}; this node is at ${tip?.height ?? 0}`
    if (payload.seed !== (tip?.hash ?? GENESIS)) return 'the jury must be drawn from the parent block hash; this seed is not the tip'
    if (expectedSealer([...this.validators.keys()], payload.height) !== payload.sealer) return `height ${payload.height} is not ${payload.sealer}'s turn`
    const members = []
    for (const m of payload.members ?? []) {
      const q = this.store.sealed(m.queueId)
      if (!q) return `queue id ${m.queueId} is not in this node's queue`
      if (q.status !== 'queued') return `queue id ${m.queueId} was already ${q.status}`
      let drawn
      try { drawn = this.#drawFor(q.meta, payload.seed).map(h => h.id) } catch (err) { return `no jury can be drawn for ${m.queueId}: ${err.message}` }
      if (canonical(drawn) !== canonical(m.jury)) return `the jury for ${m.queueId} is not the draw seeded by the parent hash`
      members.push({ id: q.id, meta: q.meta, receivedAt: q.receivedAt })
    }
    return closeProblem(members, { now: this.now(), p: this.params })
  }

  /**
   * Release this node's decryption shares for a closing block. Shares are
   * released only after the jury is drawn from the parent block hash, to the
   * sealer whose turn it is, for a member set that meets a close rule on this
   * node's own view. Otherwise nothing is released.
   * @param {object} draw - the signed draw record.
   * @returns {{queueId: string, node: string, share: {x: number, y: string}}[]} the shares.
   */
  releaseShare(draw) {
    const problem = this.drawProblem(draw)
    if (problem) throw new Error(`share withheld: ${problem}`)
    const out = draw.members.map(m => ({ queueId: m.queueId, node: this.id, share: openShare(this.store.sealed(m.queueId).env, this.id, this.queueKey.privateKey) }))
    this.log({ event: 'shares-released', node: this.id, height: draw.height, to: draw.sealer, members: draw.members.length })
    return out
  }

  /**
   * Accept a contract opened from the queue: into the mempool, and the
   * plaintext and its pins into the availability layer.
   */
  async #acceptOpened(qid, asc) {
    const h = await this.submit(asc, { gossip: false, fromQueue: true })
    this.storage.put(canonical(asc))
    this.store.openSealed(qid, h)
    this.log({ event: 'queue-opened', node: this.id, queueId: qid, asc: asc.id, ascHash: h })
    return h
  }

  /**
   * Close a block from the queue when a close rule holds: draw the juries from
   * the parent hash, sign the draw, collect t shares, open the members, publish
   * their keys, then run the rounds.
   * @returns {Promise<object | null>} the sealed block, or null when no rule holds.
   */
  async #prepareFromQueue() {
    const parent = this.tip()
    const seed = parent?.hash ?? GENESIS

    // Contracts opened for a block that was never sealed: they are public now, so seal them.
    const stranded = this.store.queue('opened').map(q => q.ascHash && this.contract(q.ascHash)).filter(c => c && c.entry.status === 'pending')
    if (stranded.length) return this.#sealRounds(stranded.map(c => ({ ...c, jury: drawJuryFor(c.asc, this.#pool(), seed) })))

    const queue = this.queueView().filter(it => { try { this.#drawFor(it.meta, seed); return true } catch { return false } })
    const decision = closeDecision(queue, { now: this.now(), p: this.params })
    if (!decision.close) return null
    const payload = {
      kind: DRAW_KIND, height: (parent?.height ?? 0) + 1, seed, sealer: this.id, time: new Date(this.now()).toISOString(),
      members: decision.members.map(qid => ({ queueId: qid, jury: this.#drawFor(this.store.sealed(qid).meta, seed).map(h => h.id) })),
    }
    const draw = { ...payload, signature: signMessage(this.identity.privateKey, payload) }

    // Shares: this node's own, then its peers'. Every node checks the draw itself.
    const shares = new Map(draw.members.map(m => [m.queueId, []]))
    for (const s of this.releaseShare(draw)) shares.get(s.queueId).push(s.share)
    for (const r of await this.peers.requestShares(draw)) {
      if (!r.ok) { this.log({ event: 'share-refused', node: this.id, peer: r.peer, error: r.error }); continue }
      for (const s of r.shares) shares.get(s.queueId)?.push(s.share)
    }
    const keys = []
    for (const m of draw.members) {
      const env = this.store.sealed(m.queueId).env
      const { asc, key } = openContract(env, shares.get(m.queueId))
      await this.#acceptOpened(m.queueId, asc)
      keys.push({ queueId: m.queueId, key })
    }
    await this.gossip.broadcast('queue-open', { draw, keys })
    const members = draw.members.map(m => this.store.sealed(m.queueId))
    const split = decision.reason === 'L1' ? null : costSplit(members.map(q => ({ id: q.id, meta: q.meta })), this.params)
    this.log({ event: 'queue-closed', node: this.id, height: draw.height, reason: decision.reason, members: members.length, blockCostUsd: split?.blockCostUsd ?? 0 })
    return this.#sealRounds(members.map(q => {
      const c = this.contract(q.ascHash)
      return { ...c, jury: drawJuryFor(c.asc, this.#pool(), seed) }
    }))
  }

  /**
   * The modeled cost split for a sealed block's batched contracts, from the
   * clear metadata of the envelopes they were opened from.
   * @param {object} block - a block.
   * @returns {object | null} the split, or null when the block holds no batched contract.
   */
  costSplit(block) {
    const opened = new Map(this.store.queue('opened').map(q => [q.ascHash, q]))
    const items = block.rulings.map(r => opened.get(r.ascHash)).filter(q => q && isBatched(q.meta)).map(q => ({ id: q.ascHash, meta: q.meta }))
    return items.length ? costSplit(items, this.params) : null
  }

  /** The sealer object core's `seal` takes: this node's id and signing function. */
  get signer() {
    return { id: this.id, sign: payload => signMessage(this.identity.privateKey, payload) }
  }

  #noteCommit(h, c) {
    this.commitments.set(`${h}:${c.harness}`, c.commitment)
  }

  /**
   * Handle a gossip message from a peer.
   * @param {string} type - contract, commit, reveal or block.
   * @param {object} msg - the payload.
   */
  async handleGossip(type, msg) {
    const cards = this.harnessCards()
    if (type === 'contract') {
      await this.submit(msg.asc, { sources: msg.sources ?? [], gossip: false })
    } else if (type === 'sealed') {
      await this.submitSealed(msg.env, { gossip: false })
    } else if (type === 'queue-open') {
      // A released key opens the contract for every node, but only for a draw this node accepts.
      const problem = this.drawProblem(msg.draw)
      if (problem) throw new Error(`queue-open refused: ${problem}`)
      for (const { queueId: qid, key } of msg.keys ?? []) {
        if (!msg.draw.members.some(m => m.queueId === qid)) throw new Error(`queue-open names ${qid}, which is not in the draw`)
        await this.#acceptOpened(qid, openWithKey(this.store.sealed(qid).env, key))
      }
    } else if (type === 'commit') {
      const card = cards.get(msg.commit?.harness)
      const problem = card ? checkCommit(card, msg.commit, msg.ascHash) : 'unknown harness'
      if (problem) throw new Error(`commit does not verify: ${problem}`)
      const key = `${msg.ascHash}:${card.id}`
      const prior = this.commitments.get(key)
      if (prior && prior !== msg.commit.commitment) throw new Error(`${card.id} equivocated: two commitments for one contract`)
      this.commitments.set(key, msg.commit.commitment)
    } else if (type === 'reveal') {
      const r = msg.reveal
      const commitment = this.commitments.get(`${msg.ascHash}:${r?.harness}`)
      if (!commitment) throw new Error(`reveal from ${r?.harness} before its commitment`)
      const problem = checkRevealRecord(cards.get(r.harness), { commitment }, r, msg.ascHash)
      if (problem) throw new Error(`reveal from ${r.harness} does not verify: ${problem}`)
    } else if (type === 'block') {
      await this.#receiveBlock(msg)
    }
  }

  async #receiveBlock(block) {
    const tipHeight = this.tip()?.height ?? 0
    if (block.height <= tipHeight) {
      if (this.store.block(block.height)?.hash === block.hash) return
      throw new BlockRejected('fork', `already hold a different block at height ${block.height}`)
    }
    if (block.height > tipHeight + 1) { this.pendingBlocks.set(block.height, block); return }
    await this.accept(block)
    // Apply any blocks that arrived early.
    for (let h = block.height + 1; this.pendingBlocks.has(h); h++) {
      const next = this.pendingBlocks.get(h)
      this.pendingBlocks.delete(h)
      await this.accept(next)
    }
  }
}
