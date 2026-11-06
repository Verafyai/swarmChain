/**
 * A Swarm Chain node: a mempool of funded contracts, jury coordination, sealer
 * rotation and a block store. A node never calls a model; harnesses do.
 *
 * Every hash, signature, agreement and diff check is from `@verafyharness/core`.
 * @module swarmchain/node
 */
import {
  createIdentity, signMessage, verifyMessage, validate, loadContext, ascHash as hashAsc,
  drawJury, checkReveal, rule, seal,
} from '#core'
import { BlockStore } from './store.js'
import { ContextStore, fetchContext } from '../../storage/src/index.js'
import { verifyBlock, expectedSealer, reviewResult, eligible, GENESIS, GROUNDS, BlockRejected } from './verify.js'
import { replayJuror } from './jury.js'

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
   */
  constructor({ id, url = '', db = ':memory:', windowMs, jurors, fetchContent = fetchContext, log = () => {} }) {
    this.id = id
    this.url = url
    this.identity = createIdentity()
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
  }

  /** @returns {{id: string, publicKey: string, url: string}} what peers need to verify this node's blocks. */
  get card() {
    return { id: this.id, publicKey: this.identity.publicKey, url: this.url }
  }

  /**
   * Add a validator node to the sealer rotation.
   * @param {{id: string, publicKey: string}} card - the node's id and key.
   */
  addValidator({ id, publicKey }) {
    this.validators.set(id, publicKey)
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
   * their pins, kept in storage, and stripped from the stored contract.
   * @param {object} asc - the contract, with or without context bytes.
   * @param {{challenge?: {ruling: string, grounds: string} | null, sources?: string[], gossip?: boolean}} [options] -
   *   a challenge, places to fetch missing context, and whether to gossip it.
   * @returns {Promise<string>} the contract's hash.
   */
  async submit(asc, { challenge = null, sources = [], gossip = true } = {}) {
    const problems = validate(asc)
    if (problems.length) throw new Error(`contract rejected: ${problems.join('; ')}`)
    if (challenge) {
      if (!GROUNDS.includes(challenge.grounds)) throw new Error(`contract rejected: unknown grounds "${challenge.grounds}"`)
      if (!this.store.ruling(challenge.ruling)) throw new Error(`contract rejected: challenged ruling ${challenge.ruling} is not on chain`)
    }
    const h = hashAsc(asc)
    if (this.store.contract(h)) return h
    const filled = { ...asc, context: await Promise.all(asc.context.map(async c => typeof c.content === 'string' ? c : { ...c, content: this.storage.get(c.sha256) ?? await this.fetchContent(c.sha256, sources) })) }
    const loaded = loadContext(filled)
    if (!loaded.ok) throw new Error(`contract rejected: ${loaded.problems.join('; ')}`)
    for (const c of filled.context) this.storage.put(c.content, c.sha256)
    const stripped = { ...asc, context: asc.context.map(({ content, ...meta }) => meta) }
    this.store.addContract(h, stripped, challenge)
    this.log({ event: 'contract', node: this.id, asc: asc.id, ascHash: h })
    if (gossip) await this.gossip.broadcast('contract', { asc: stripped, challenge, sources: [this.url, ...sources].filter(Boolean) })
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
      seenCommitment: (h, harness) => this.commitments.get(`${h}:${harness}`),
    }
  }

  /**
   * Verify a block and append it. Throws BlockRejected and changes nothing if any check fails.
   * @param {object} block - the block.
   * @returns {Promise<object>} the block.
   */
  async accept(block) {
    const { rulings, reviews, settlements } = await verifyBlock(block, this.#view())
    this.store.append(block, rulings, reviews, () => {
      for (const s of settlements) {
        this.store.settleContract(s.ascHash, s.status, block.hash, s.carried)
        for (const c of s.context) this.storage.retain(c, Date.parse(block.time))
      }
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
      if (entry.challenge && !this.store.ruling(entry.challenge.ruling)) continue
      try {
        const jury = drawJury(eligible(pool, entry.asc), entry.asc.payment.jury, seed)
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
    if (!next) return null
    const { entry, asc, jury } = next
    const h = entry.ascHash
    const parent = this.tip()
    const seed = parent?.hash ?? GENESIS

    // Commit round: every juror deliberates and publishes only a commitment.
    const settled = await Promise.allSettled(jury.map(j => this.jurors.commit(j.entry, asc)))
    const commits = []
    settled.forEach((s, i) => {
      const card = jury[i]
      if (s.status === 'fulfilled' && verifyMessage(card.publicKey, s.value.attestation, s.value.signature)) commits.push(s.value)
      else this.log({ event: 'commit-failed', node: this.id, harness: card.id, error: String(s.reason?.message ?? 'bad signature') })
    })
    for (const c of commits) { this.#noteCommit(h, c); await this.gossip.broadcast('commit', { ascHash: h, commit: c }) }

    // Reveal round opens only after the commit round closes.
    const reveals = []
    for (const c of commits) {
      const card = jury.find(j => j.id === c.harness)
      try {
        const r = await this.jurors.reveal(card.entry, h)
        if (checkReveal(h, r.vote, r.salt, c.commitment)) { reveals.push(r); await this.gossip.broadcast('reveal', { ascHash: h, reveal: r }) }
        else this.log({ event: 'reveal-failed', node: this.id, harness: c.harness })
      } catch (err) {
        this.log({ event: 'reveal-failed', node: this.id, harness: c.harness, error: err.message })
      }
    }

    // Core rules from the recorded messages, exactly as every verifier will.
    const cards = this.harnessCards()
    const replay = jury.map(j => replayJuror(cards.get(j.id), commits.find(c => c.harness === j.id), reveals.find(r => r.harness === j.id)))
    const ruling = await rule(asc, replay, { id: this.id })
    const envelope = { ...ruling, round: { seed, jury: jury.map(j => j.id), commits, reveals } }
    if (entry.challenge) {
      const target = this.store.ruling(entry.challenge.ruling)
      envelope.review = { ...entry.challenge, result: reviewResult(target.ruling, ruling, entry.challenge.grounds) }
    }
    return seal(parent, [envelope], this.signer)
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
      await this.submit(msg.asc, { challenge: msg.challenge, sources: msg.sources ?? [], gossip: false })
    } else if (type === 'commit') {
      const card = cards.get(msg.commit?.harness)
      if (!card || !verifyMessage(card.publicKey, msg.commit.attestation, msg.commit.signature)) throw new Error('commit signature does not verify')
      const key = `${msg.ascHash}:${card.id}`
      const prior = this.commitments.get(key)
      if (prior && prior !== msg.commit.commitment) throw new Error(`${card.id} equivocated: two commitments for one contract`)
      this.commitments.set(key, msg.commit.commitment)
    } else if (type === 'reveal') {
      const r = msg.reveal
      const commitment = this.commitments.get(`${msg.ascHash}:${r?.harness}`)
      if (!commitment) throw new Error(`reveal from ${r?.harness} before its commitment`)
      if (!checkReveal(msg.ascHash, r.vote, r.salt, commitment)) throw new Error(`reveal from ${r.harness} does not match its commitment`)
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
