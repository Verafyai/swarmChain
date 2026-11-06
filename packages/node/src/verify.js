/**
 * Block verification. Every node runs this on every block, including the ones
 * it seals itself. Every hash, signature, reveal, agreement and diff check is a
 * call into `@verafyharness/core`; what lives here is the order of checks and the
 * chain's design rules:
 *
 *   no empty blocks              a block exists only when a jury rules
 *   proofs stay off chain        a block may carry proof hashes, never proofs
 *   sealer rotation              the expected node signed the header
 *   context pins checked         every pin matches bytes the node holds
 *   juries span labs             and were drawn from the parent block hash
 *   reveals match commitments    and every signature verifies
 *   declared exits only          the exit and every vote are declared outcomes
 *   diffs conserve               checked by core's `conserves`
 *   every counted vote paid      dissent included; below the bar, nobody is paid
 *                                and the escrow carries to the escalated jury
 *   rulings append-only          a challenge appends affirm, overturn or supersede
 *
 * @module swarmchain/node/verify
 */
import {
  sha256, canonical, ascHash as hashAsc, validate, loadContext, drawJury,
  verifyMessage, checkReveal, conserves, rule, BELOW_BAR,
} from '#core'
import { replayJuror } from './jury.js'

/** The parent hash of the first block, as core's `seal` writes it. */
export const GENESIS = '0'.repeat(64)

/** Grounds a challenge may state, from the draft rulings SIMD. */
export const GROUNDS = ['new-evidence', 'false-evidence', 'error', 'changed-rules']

export class BlockRejected extends Error {
  /**
   * @param {string} code - a short, stable reason code.
   * @param {string} message - what was wrong.
   */
  constructor(code, message) {
    super(`block rejected (${code}): ${message}`)
    this.code = code
  }
}

const reject = (code, message) => { throw new BlockRejected(code, message) }

/**
 * The header fields core's `seal` hashes and signs.
 * @param {object} block - a block.
 * @returns {object} its header.
 */
export function headerOf(block) {
  const { height, parent, rulingsRoot, sealer, time } = block
  return { height, parent, rulingsRoot, sealer, time }
}

/**
 * A ruling's id: the SHA-256 of its envelope.
 * @param {object} envelope - the ruling as sealed.
 * @returns {string} SHA-256 hex.
 */
export function rulingId(envelope) {
  return sha256(envelope)
}

/**
 * Sealer rotation: validators take turns by height, in id order.
 * @param {string[]} validators - validator node ids.
 * @param {number} height - the block height to seal.
 * @returns {string} the node id that must seal it.
 */
export function expectedSealer(validators, height) {
  const ids = [...validators].sort()
  return ids[(height - 1) % ids.length]
}

/**
 * Harnesses eligible for a contract's jury: those whose bond covers the most
 * value one vote can decide. Both the sealer and every verifier draw from this pool.
 * @param {object[]} cards - registered harness cards.
 * @param {object} asc - the contract.
 * @returns {object[]} the eligible cards, in the order given.
 */
export function eligible(cards, asc) {
  const min = asc.payment.maxValuePerVote ?? 0
  return cards.filter(c => c.bond >= min)
}

/**
 * Verify a block against this node's view of the chain.
 * @param {object} block - the block to check.
 * @param {object} ctx - the node's view:
 * @param {object | null} ctx.parent - the current tip.
 * @param {Map<string, string>} ctx.validators - validator node id to public key.
 * @param {Map<string, object>} ctx.harnesses - harness id to registered card.
 * @param {(h: string) => ({entry: object, asc: object} | null)} ctx.contract - a mempool entry with its context bytes attached.
 * @param {(id: string) => (object | null)} ctx.ruling - a sealed ruling by id.
 * @param {(h: string, harness: string) => (string | undefined)} [ctx.seenCommitment] - a commitment this node saw in gossip.
 * @returns {Promise<{rulings: {id: string, ruling: object}[], reviews: object[], settlements: object[]}>} what to append.
 */
export async function verifyBlock(block, ctx) {
  if (!Array.isArray(block?.rulings) || block.rulings.length === 0) reject('empty', 'a block exists only when a jury rules; this one has no rulings')
  const proofAt = findKey(block, k => k === 'proof' || k === 'proofs')
  if (proofAt) reject('proof-on-chain', `proofs stay off chain; found "${proofAt}". Record a proof hash and keep the proof available instead`)

  const parent = ctx.parent
  const height = (parent?.height ?? 0) + 1
  if (block.height !== height) reject('link', `expected height ${height}, got ${block.height}`)
  if (block.parent !== (parent?.hash ?? GENESIS)) reject('link', `parent ${block.parent} is not the tip ${parent?.hash ?? GENESIS}`)
  const header = headerOf(block)
  if (sha256(header) !== block.hash) reject('hash', 'block hash does not match its header')
  const sealer = expectedSealer([...ctx.validators.keys()], height)
  if (block.sealer !== sealer) reject('sealer', `height ${height} is ${sealer}'s turn, not ${block.sealer}'s`)
  if (!verifyMessage(ctx.validators.get(sealer), header, block.signature)) reject('sealer', 'sealer signature does not verify')
  if (sha256(block.rulings.map(r => sha256(r)).join('')) !== block.rulingsRoot) reject('root', 'rulings root does not match the rulings')

  const out = { rulings: [], reviews: [], settlements: [] }
  const inBlock = new Set()
  for (const env of block.rulings) {
    if (inBlock.has(env.ascHash)) reject('already-ruled', `contract ${env.ascHash} appears twice`)
    inBlock.add(env.ascHash)
    const result = await verifyRuling(env, block, ctx)
    out.rulings.push({ id: rulingId(env), ruling: env })
    if (result.review) out.reviews.push({ ...result.review, byRuling: rulingId(env) })
    out.settlements.push(result.settlement)
  }
  return out
}

async function verifyRuling(env, block, ctx) {
  const found = ctx.contract(env.ascHash)
  if (!found) reject('unknown-contract', `contract ${env.ascHash} is not in this node's mempool`)
  const { entry, asc } = found
  if (entry.status !== 'pending') reject('already-ruled', `contract ${asc.id} was already ${entry.status}`)
  if (hashAsc(asc) !== env.ascHash) reject('unknown-contract', 'contract hash does not match')
  const problems = validate(asc)
  if (problems.length) reject('contract', problems.join('; '))

  // Context is evidence: every pin is checked against bytes this node holds.
  const loaded = loadContext(asc)
  if (!loaded.ok) reject('context', loaded.problems.join('; '))
  if (canonical(env.contextHashes) !== canonical(asc.context.map(c => c.sha256))) reject('context', 'ruling cites context hashes the contract did not pin')

  // Juries span labs, and are drawn from the parent block hash.
  const round = env.round ?? reject('round', 'ruling carries no commit and reveal record')
  const rules = asc.payment.jury
  const cards = round.jury.map(id => ctx.harnesses.get(id) ?? reject('jury-unknown', `juror ${id} is not registered`))
  const labs = new Set(cards.map(c => c.lab))
  if (cards.length !== rules.size) reject('jury-size', `jury has ${cards.length} seats, the contract asks for ${rules.size}`)
  if (labs.size < rules.minLabs) reject('jury-labs', `jury spans ${labs.size} labs; the contract requires ${rules.minLabs}`)
  const minBond = asc.payment.maxValuePerVote ?? 0
  for (const c of cards) if (c.bond < minBond) reject('jury-bond', `${c.id} bonds ${c.bond}, below ${minBond} per vote`)
  const seed = block.parent
  if (round.seed !== seed) reject('jury-draw', 'jury seed is not the parent block hash')
  const drawn = drawJury(eligible([...ctx.harnesses.values()], asc), rules, seed).map(h => h.id)
  if (canonical(drawn) !== canonical(round.jury)) reject('jury-draw', `jury is not the draw seeded by the parent hash (expected ${drawn.join(', ')})`)

  // Commitments: signed by the registered key, for this contract.
  const commits = new Map()
  for (const c of round.commits) {
    const card = ctx.harnesses.get(c.harness)
    if (!card || !round.jury.includes(c.harness)) reject('commit', `${c.harness} is not on this jury`)
    if (commits.has(c.harness)) reject('commit', `${c.harness} committed twice`)
    const a = c.attestation ?? {}
    if (a.harness !== c.harness || a.ascHash !== env.ascHash || a.commitment !== c.commitment || a.lab !== card.lab || a.model !== card.model) reject('commit', `${c.harness} attestation does not match its commitment`)
    if (!verifyMessage(card.publicKey, a, c.signature)) reject('commit', `${c.harness} commitment signature does not verify`)
    const seen = ctx.seenCommitment?.(env.ascHash, c.harness)
    if (seen && seen !== c.commitment) reject('commit-equivocation', `${c.harness} gossiped a different commitment`)
    commits.set(c.harness, c)
  }

  // Reveals must match their commitments.
  const reveals = new Map()
  for (const r of round.reveals) {
    const c = commits.get(r.harness)
    if (!c) reject('reveal-mismatch', `${r.harness} revealed without committing`)
    if (r.ascHash !== env.ascHash || !checkReveal(env.ascHash, r.vote, r.salt, c.commitment)) reject('reveal-mismatch', `${r.harness} reveal does not match its commitment`)
    const card = ctx.harnesses.get(r.harness)
    if (!verifyMessage(card.publicKey, { harness: r.harness, ascHash: env.ascHash, vote: r.vote, salt: r.salt }, r.signature)) reject('reveal-mismatch', `${r.harness} reveal signature does not verify`)
    reveals.set(r.harness, r)
  }

  // Exits are declared: the jury can only choose a declared outcome.
  const declared = asc.exits.map(e => e.outcome)
  const type = asc.question.answer.type
  if (!declared.includes(env.exit)) reject('exit-undeclared', `exit "${env.exit}" is not declared by the contract`)
  if (type !== 'forecast') {
    for (const r of reveals.values()) if (!asc.question.answer.options.includes(r.vote.answer)) reject('exit-undeclared', `${r.harness} voted "${r.vote.answer}", not a declared option`)
    if (env.passed && env.exit !== env.answer) reject('exit-undeclared', `exit "${env.exit}" does not match answer "${env.answer}"`)
  }
  if (!env.passed && env.exit !== BELOW_BAR) reject('exit-undeclared', `a ruling below the bar must take "${BELOW_BAR}"`)

  // Diffs conserve.
  if (!Array.isArray(env.diff) || !conserves(env.diff)) reject('diff-conserve', 'diff does not conserve totals')

  // Pay every counted vote, dissent included. Below the bar, pay nobody and carry the escrow.
  const counted = env.votes.map(v => v.harness)
  const jurorPay = env.diff.filter(d => d.account.startsWith('harness:') && d.account !== `harness:${block.sealer}`)
  if (env.passed) {
    for (const id of counted) {
      const paid = jurorPay.filter(d => d.account === `harness:${id}`)
      if (paid.length !== 1 || !(paid[0].delta > 0)) reject('pay', `counted vote by ${id} is not paid`)
    }
    if (jurorPay.length !== counted.length) reject('pay', 'diff pays a harness whose vote was not counted')
    if (new Set(jurorPay.map(d => d.delta)).size > 1) reject('pay', 'counted votes are not paid equally')
  } else {
    if (env.diff.some(d => d.account.startsWith('harness:'))) reject('pay', 'a ruling below the bar never pays jurors or the sealer')
    const carry = env.diff.find(d => d.account === `escrow:${asc.id}:escalation`)
    if (!carry || Math.abs(carry.delta - asc.payment.escrow) > 1e-9) reject('pay', 'a ruling below the bar must carry its whole escrow to the escalated jury')
  }

  // Re-run the ruling with core from the recorded messages; it must come out identical.
  const replay = round.jury.map(id => replayJuror(ctx.harnesses.get(id), commits.get(id), reveals.get(id)))
  const failed = []
  const again = await rule(asc, replay, { id: block.sealer }, e => { if (e.phase === 'reveal-failed' && reveals.has(e.harness)) failed.push(e.harness) })
  if (failed.length) reject('reveal-mismatch', `core rejected reveals from ${failed.join(', ')}`)
  const { round: _r, review: _v, ...sealed } = env
  if (canonical(again) !== canonical(sealed)) reject('replay', 'ruling does not match what core computes from its commitments and reveals')

  // Challenges append a review; they never edit the original.
  let review = null
  if (entry.challenge || env.review) {
    const want = entry.challenge
    if (!want || !env.review || want.ruling !== env.review.ruling || want.grounds !== env.review.grounds) reject('review', 'ruling and mempool disagree about the challenge')
    if (!GROUNDS.includes(want.grounds)) reject('review', `unknown grounds "${want.grounds}"`)
    const target = ctx.ruling(want.ruling) ?? reject('review', `challenged ruling ${want.ruling} is not on chain`)
    const expected = reviewResult(target.ruling, env, want.grounds)
    if (env.review.result !== expected) reject('review', `challenge result should be "${expected}", not "${env.review.result}"`)
    if (expected !== 'stands') review = { ruling: want.ruling, result: expected, grounds: want.grounds }
  }

  const carried = env.passed ? 0 : asc.payment.escrow
  return { review, settlement: { ascHash: env.ascHash, status: env.passed ? 'ruled' : 'escalated', carried, context: env.contextHashes } }
}

/**
 * What a challenge ruling does to the ruling it reviews, from the draft rulings SIMD:
 * same outcome affirms; a different outcome overturns, or supersedes when the grounds
 * are changed rules; no ruling (below the bar) leaves the original standing.
 * @param {object} original - the challenged ruling envelope.
 * @param {object} challenge - the challenge ruling (core fields).
 * @param {string} grounds - one of GROUNDS.
 * @returns {'affirm' | 'overturn' | 'supersede' | 'stands'} the result.
 */
export function reviewResult(original, challenge, grounds) {
  if (!challenge.passed) return 'stands'
  if (canonical(challenge.answer) === canonical(original.answer)) return 'affirm'
  return grounds === 'changed-rules' ? 'supersede' : 'overturn'
}

function findKey(value, test, path = '') {
  if (value === null || typeof value !== 'object') return null
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k
    if (!Array.isArray(value) && test(k)) return here
    const deeper = findKey(v, test, here)
    if (deeper) return deeper
  }
  return null
}
