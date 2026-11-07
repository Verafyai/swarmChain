/**
 * Block verification. Every node runs this on every block, including the ones
 * it seals itself. Every hash, signature, reveal, agreement, pay and diff check
 * is a call into `@verafyharness/core`; what lives here is the order of checks,
 * a stable rejection code for each, and the chain's design rules:
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
 *   core agrees                  core's `verifyRuling` re-runs the ruling from its round
 *   L2 proofs                    every counted vote has a proof record whose
 *                                checks, signed by validator nodes, pass; only
 *                                proof hashes are on chain
 *   rulings append-only          a challenge appends affirm, overturn or supersede
 *   batching                     an L1 contract seals alone; no contract seals in a
 *                                block smaller than its minBatch
 *   the ethics gate              every contract ruled in a block was screened
 *                                allow in that block; a refused contract is never
 *                                ruled and its whole escrow returns; every panel
 *                                ruling and outcome is recomputed (ethics.js)
 *   amendments                   every stage record cites the one before, none
 *                                skipped and nothing after a stop; no harness sits
 *                                on two panels of one amendment; no proposer or
 *                                commenter harness on any panel; nothing that
 *                                weakens an entrenched clause gets past the
 *                                constitution check; windows have run; every
 *                                panel ruling and result is recomputed (governance.js)
 *
 * @module swarmchain/node/verify
 */
import {
  sha256, canonical, ascHash as hashAsc, validate, loadContext, drawJuryFor, eligibleJurors,
  verifyMessage, checkCommit, checkRevealRecord, conserves, checkPay, accountFor, verifyRuling,
  blockHeader, rulingId, resolveChallenge, appendReview, BELOW_BAR, CHALLENGE_KIND, GROUNDS,
  entrenchment, drawJury,
} from '#core'

import { isBatched } from './batch.js'
import { SCREENING_KIND, subjectOf, screeningContract, widerContract, panelOutcome, screeningEntry, same } from './ethics.js'
import {
  STAGE_KIND, PANEL_STAGES, passes, nextStage, recordId, panelists, commenters, commentProblem, stageContract,
  widerStage, stageResult, escrowUse,
} from './governance.js'

export { rulingId, GROUNDS }

/** The parent hash of the first block, as core's `seal` writes it. */
export const GENESIS = '0'.repeat(64)

/** How far ahead of a verifier's clock a block's time may be. */
export const MAX_CLOCK_SKEW_MS = 60_000

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
 * The account a node is paid into as sealer.
 * @param {string} nodeId - the sealing node's id.
 * @returns {string} `node:<id>`.
 */
export function sealerAccount(nodeId) {
  return accountFor({ id: nodeId, kind: 'node' })
}

/**
 * The seal time for the next block: the sealer's clock, but always after the
 * parent's time. The sealer passes it to core's `seal`, so any node rebuilds the
 * header from the block alone.
 * @param {{time: string} | null} parent - the tip.
 * @param {number} [now] - the sealer's clock, in ms.
 * @returns {string} ISO time.
 */
export function sealTime(parent, now = Date.now()) {
  const after = parent ? Date.parse(parent.time) + 1 : 0
  return new Date(Math.max(now, after)).toISOString()
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
 * Chain checks on a challenge contract (core's `challengeContract` format), run
 * in the mempool and again on every block: the ruling it names is on chain, is
 * for the contract it says, cleared the bar, and none of its jurors sits on the
 * challenge jury, which is at least as large.
 * @param {object} asc - the challenge contract (it has `review`).
 * @param {(id: string) => ({ruling: object} | null)} lookup - a sealed ruling by id.
 * @returns {string | null} the problem, or null.
 */
export function challengeProblem(asc, lookup) {
  const r = asc.review
  if (r?.kind !== CHALLENGE_KIND) return `review.kind must be "${CHALLENGE_KIND}"`
  if (!GROUNDS.includes(r.grounds)) return `unknown grounds "${r.grounds}"`
  const target = lookup(r.ruling)
  if (!target) return `challenged ruling ${r.ruling} is not on chain`
  const original = target.ruling
  if (original.ascHash !== r.ascHash) return 'challenge names the wrong contract for that ruling'
  if (!original.passed) return 'a ruling below the bar escalates; it cannot be challenged'
  const jury = asc.payment.jury
  const excluded = new Set(jury.excludeHarnesses ?? [])
  const sat = original.round.jury.map(c => c.id).filter(id => !excluded.has(id))
  if (sat.length) return `the challenge jury must exclude the original jurors (${sat.join(', ')})`
  if (jury.size < original.round.jury.length) return 'a challenge jury is at least as large as the original'
  return null
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
 * @param {(id: string) => object[]} ctx.reviews - a sealed ruling's review log, oldest first.
 * @param {(h: string, harness: string) => (string | undefined)} [ctx.seenCommitment] - a commitment this node saw in gossip.
 * @param {number} [ctx.now] - this node's clock, in ms.
 * @returns {{rulings: {id: string, ruling: object}[], reviews: object[], settlements: object[]}} what to append.
 */
export function verifyBlock(block, ctx) {
  const panelsIn = list => (list ?? []).some(x => Array.isArray(x?.panels) && x.panels.length)
  if (!Array.isArray(block?.rulings) || (block.rulings.length === 0 && !panelsIn(block.screenings) && !panelsIn(block.governance))) reject('empty', 'a block exists only when a jury rules; this one has no rulings')
  const proofAt = findKey(block, k => k === 'proof' || k === 'proofs')
  if (proofAt) reject('proof-on-chain', `proofs stay off chain; found "${proofAt}". Record a proof hash and keep the proof available instead`)

  const parent = ctx.parent
  const height = (parent?.height ?? 0) + 1
  if (block.height !== height) reject('link', `expected height ${height}, got ${block.height}`)
  if (block.parent !== (parent?.hash ?? GENESIS)) reject('link', `parent ${block.parent} is not the tip ${parent?.hash ?? GENESIS}`)
  const header = blockHeader(block)
  if (sha256(header) !== block.hash) reject('hash', 'block hash does not match its header')
  const sealer = expectedSealer([...ctx.validators.keys()], height)
  if (block.sealer !== sealer) reject('sealer', `height ${height} is ${sealer}'s turn, not ${block.sealer}'s`)
  if (!verifyMessage(ctx.validators.get(sealer), header, block.signature)) reject('sealer', 'sealer signature does not verify')
  const t = Date.parse(block.time)
  if (Number.isNaN(t)) reject('time', `block time "${block.time}" is not a date`)
  if (parent && !(t > Date.parse(parent.time))) reject('time', 'block time is not after its parent')
  if (t > (ctx.now ?? Date.now()) + MAX_CLOCK_SKEW_MS) reject('time', 'block time is in the future')
  if (sha256(block.rulings.map(r => sha256(r)).join('')) !== block.rulingsRoot) reject('root', 'rulings root does not match the rulings')

  const out = { rulings: [], reviews: [], settlements: [], panels: [], refused: [] }
  const inBlock = new Set()
  const refusedHere = (block.screenings ?? []).filter(x => x?.subjectKind === 'contract' && x.outcome === 'refuse').length
  for (const ruling of block.rulings) {
    if (inBlock.has(ruling.ascHash)) reject('already-ruled', `contract ${ruling.ascHash} appears twice`)
    inBlock.add(ruling.ascHash)
    const { asc, settlement } = checkRuling(ruling, block, ctx)
    if (block.rulings.length > 1 && !isBatched(asc)) reject('batch', `${asc.id} is an L1 contract; L1 contracts do not batch, each seals alone`)
    if ((asc.payment.minBatch ?? 1) > block.rulings.length + refusedHere) reject('batch-min', `${asc.id} sets minBatch ${asc.payment.minBatch}; this block holds ${block.rulings.length}`)
    out.rulings.push({ id: rulingId(ruling), ruling })
    out.settlements.push(settlement)

    // Challenges append a review to the ruling they name; the original is never edited.
    // A challenge that rules below the bar leaves the original standing and appends nothing.
    if (asc.review) {
      let review
      try { review = resolveChallenge(asc, ruling, ctx.ruling(asc.review.ruling).ruling) } catch (err) { reject('review', err.message) }
      if (review.result === 'stands') continue
      const log = [...ctx.reviews(review.ruling), ...out.reviews.filter(r => r.ruling === review.ruling)]
      try { appendReview(log, review) } catch (err) { reject('review', err.message) }
      out.reviews.push(review)
    }
  }

  // Reviews ride in the block of the challenge ruling that decided them, under the reviews root.
  const reviews = block.reviews ?? []
  if ((reviews.length || block.reviewsRoot !== undefined) && sha256(reviews.map(r => sha256(r)).join('')) !== block.reviewsRoot) reject('review', 'reviews root does not match the reviews')
  if (canonical(reviews) !== canonical(out.reviews)) reject('review', `block reviews are not what core's resolveChallenge gives (expected ${out.reviews.map(r => r.result).join(', ') || 'none'})`)

  checkGate(block, ctx, out)
  checkGovernance(block, ctx, out)
  return out
}

/**
 * The ethics gate (Article 3). Every contract ruled in this block must carry an
 * allow screening in this block; every screening is recomputed from its panels.
 * There is no exemption: no field, flag or kind skips this check.
 */
function checkGate(block, ctx, out) {
  const screenings = block.screenings ?? []
  if (!Array.isArray(screenings)) reject('ethics-gate', 'screenings must be a list')
  if ((screenings.length || block.screeningsRoot !== undefined) && sha256(screenings.map(r => sha256(r)).join('')) !== block.screeningsRoot) reject('ethics-gate', 'screenings root does not match the screenings')
  const bySubject = new Map()
  for (const s of screenings) {
    if (s?.kind !== SCREENING_KIND) reject('ethics-gate', `a screening entry is "${SCREENING_KIND}"`)
    if (bySubject.has(s.subject)) reject('ethics-gate', `${s.id} is screened twice in one block`)
    let x
    let exclude = []
    if (s.subjectKind === 'contract') {
      const found = ctx.contract(s.subject) ?? reject('unknown-contract', `screened contract ${s.subject} is not in this node's mempool`)
      if (found.entry.status !== 'pending') reject('already-ruled', `contract ${found.asc.id} was already ${found.entry.status}`)
      x = found.asc
    } else if (s.subjectKind === 'amendment') {
      x = ctx.amendmentByHash?.(s.subject) ?? reject('amendment-unknown', `screened amendment ${s.subject} is not held by this node`)
      exclude = x.proposer?.harnesses ?? []
    } else reject('ethics-gate', `unknown screening subject kind "${s.subjectKind}"`)
    bySubject.set(s.subject, verifyScreening(s, x, block, ctx, exclude))
    for (const r of s.panels) out.panels.push({ id: rulingId(r), ruling: r })
    if (s.subjectKind === 'contract' && s.outcome === 'refuse') out.refused.push(s.subject)
  }
  for (const r of block.rulings) {
    const e = bySubject.get(r.ascHash)
    if (!e || e.outcome !== 'allow') reject('ethics-gate', `${r.asc} entered a block without an allow ruling from the ethics gate (Article 3.1: every contract is screened before it can enter a block; there is no bypass)`)
  }
  const ruled = new Set(block.rulings.map(r => r.ascHash))
  for (const [h, e] of bySubject) if (e.subjectKind === 'contract' && e.outcome === 'allow' && !ruled.has(h)) reject('ethics-gate', `${e.id} was allowed but not ruled in the block that screened it`)
}

/** Recompute one screening entry from its panels. */
function verifyScreening(entry, x, block, ctx, exclude) {
  const subject = subjectOf(x)
  if (!Array.isArray(entry.panels) || entry.panels.length === 0) reject('ethics-gate', `the screening of ${subject.id} carries no panel ruling`)
  const first = screeningContract(subject, ctx.ethics, ctx.ethicsText, { exclude })
  checkRuling(entry.panels[0], block, ctx, first)
  const readings = [panelOutcome(1, entry.panels[0])]
  let unseated
  if (readings[0].outcome === 'escalate') {
    const wider = widerContract(subject, first, entry.panels[0], ctx.ethics, ctx.ethicsText)
    if (entry.panels[1]) {
      checkRuling(entry.panels[1], block, ctx, wider)
      readings.push(panelOutcome(2, entry.panels[1]))
    } else {
      unseated = unseatable(wider, ctx, block.parent)
      if (!unseated) reject('ethics-gate', `${subject.id}: a wider ethics panel can be seated, so the close call must go to it`)
    }
  }
  if (entry.panels.length > readings.length) reject('ethics-gate', `${subject.id}: a wider panel sits only after the first panel escalates`)
  const expected = screeningEntry(x, entry.panels, readings, unseated)
  if (!same(expected, entry)) reject('ethics-gate', `the screening of ${subject.id} is not what its panels decided (expected ${expected.outcome}: ${expected.why})`)
  return expected
}

/** Why no panel can be seated for a contract from the registered pool, or null when one can. */
function unseatable(asc, ctx, seed) {
  try { drawJuryFor(asc, [...ctx.harnesses.values()], seed); return null } catch (err) { return err.message }
}

/**
 * Amendments (Article 5): every stage record in the block, in order.
 */
function checkGovernance(block, ctx, out) {
  const records = block.governance ?? []
  if (!Array.isArray(records)) reject('amendment-stage', 'governance must be a list')
  if ((records.length || block.governanceRoot !== undefined) && sha256(records.map(r => sha256(r)).join('')) !== block.governanceRoot) reject('amendment-stage', 'governance root does not match the governance records')
  if (!records.length) return
  const hist = ctx.history()
  const p = ctx.amendParams
  const constitution = ctx.constitution()
  const added = new Map()
  for (const r of records) {
    if (r?.kind !== STAGE_KIND) reject('amendment-stage', `a governance record is "${STAGE_KIND}"`)
    const a = ctx.amendment(r.amendment) ?? reject('amendment-unknown', `amendment ${r.amendment} is not held by this node`)
    if (sha256(a) !== r.amendmentHash) reject('amendment-unknown', `${a.id}: the record names another text`)
    const entries = [...(hist.get(a.id) ?? []), ...(added.get(a.id) ?? [])]
    const last = entries.at(-1)
    const earlier = id => ctx.amendment(id)

    // Entrenched clauses: an amendment that could weaken one stops at the constitution check, and nothing comes after.
    const e = entrenchment(a, earlier)
    if (e.weakens && !['propose', 'comment'].includes(r.stage) && !(r.stage === 'constitution-check' && r.result === 'conflicts')) reject('amendment-entrenched', `${a.id} would weaken an entrenched clause (${e.problems.join('; ')}); it can only stop at the constitution check`)

    // Seven stages, in order, each citing the one before; nothing after a stop.
    if (last && !passes(last.record)) reject('amendment-stage', `${a.id} stopped at ${last.record.stage} (${last.record.result}); nothing follows a stop`)
    const expected = nextStage(entries)
    if (r.stage !== expected) reject('amendment-stage', `${a.id}: the next stage is ${expected ?? 'none (sealed)'}, not ${r.stage}; no stage can be skipped`)
    if (r.cites !== (last ? last.id : 'block:0')) reject('amendment-stage', `${a.id} ${r.stage} must cite ${last ? `the ${last.record.stage} record ${last.id}` : 'block:0'}`)

    // Panels: no proposer or commenter harness, and no harness on two stages (or twice in one).
    const jurors = (r.panels ?? []).flatMap(x => x?.round?.jury?.map(c => c.id) ?? [])
    const barred = new Set([...(a.proposer?.harnesses ?? []), ...commenters(entries)])
    for (const j of jurors) if (barred.has(j)) reject('amendment-excluded', `${j} is the proposer's or a commenter's harness, and may not sit on any panel for ${a.id}`)
    const sat = new Set(panelists(entries))
    const seen = new Set()
    for (const j of jurors) {
      if (sat.has(j) || seen.has(j)) reject('amendment-reuse', `${j} already sat on a panel for ${a.id}; a harness sits on at most one stage`)
      seen.add(j)
    }

    const head = { kind: STAGE_KIND, amendment: a.id, amendmentHash: r.amendmentHash }
    let want
    let screening
    if (r.stage === 'propose') {
      screening = (block.screenings ?? []).find(s => s.subject === r.amendmentHash) ?? reject('amendment-stage', `${a.id} is proposed without an ethics screening in the same block`)
      for (const j of screening.panels.flatMap(x => x.round.jury.map(c => c.id))) if (barred.has(j)) reject('amendment-excluded', `${j} is the proposer's harness, and may not sit on any panel for ${a.id}`)
      const allowed = screening.outcome === 'allow'
      want = { ...head, stage: 'propose', cites: 'block:0', result: allowed ? 'allow' : 'refused', screening: r.amendmentHash, ...(allowed ? {} : { escrow: { used: 0, returned: a.payment.escrow } }) }
    } else if (r.stage === 'comment') {
      if (Date.parse(block.time) < Date.parse(last.time) + p.commentWindowMs) reject('amendment-window', `${a.id}: the comment window is open until ${new Date(Date.parse(last.time) + p.commentWindowMs).toISOString()}`)
      const cards = ctx.harnesses
      for (const c of r.comments ?? []) {
        const held = ctx.comment(a.id, c.hash) ?? reject('amendment-comment', `${a.id}: comment ${c.hash} is not held by this node`)
        const problem = commentProblem(held, cards)
        if (problem || held.amendment !== a.id || (held.harness ?? null) !== c.harness) reject('amendment-comment', `${a.id}: comment ${c.hash}: ${problem ?? 'does not match its record'}`)
      }
      want = { ...head, stage: 'comment', cites: last.id, result: 'closed', opened: last.time, closed: block.time, comments: r.comments ?? [] }
    } else if (PANEL_STAGES[r.stage]) {
      let filings = []
      if (r.stage === 'challenge') {
        if (Date.parse(block.time) < Date.parse(last.time) + p.challengeWindowMs) reject('amendment-window', `${a.id}: the challenge window is open until ${new Date(Date.parse(last.time) + p.challengeWindowMs).toISOString()}`)
        if (r.result === 'unchallenged') {
          want = { ...head, stage: 'challenge', cites: last.id, result: 'unchallenged', opened: last.time, closed: block.time }
        } else filings = (r.filings ?? []).map(h => ctx.filing(a.id, h) ?? reject('amendment-comment', `${a.id}: challenge filing ${h} is not held by this node`))
      }
      if (!want) {
        if (!Array.isArray(r.panels) || r.panels.length === 0) reject('amendment-stage', `${a.id} ${r.stage} carries no panel ruling`)
        const comments = (entries.find(x => x.record.stage === 'comment')?.record.comments ?? []).map(c => ctx.comment(a.id, c.hash))
        const exclude = [...(a.proposer?.harnesses ?? []), ...commenters(entries), ...panelists(entries)]
        const first = stageContract(a, r.stage, { params: p, cites: last, comments, filings, exclude, constitution })
        checkRuling(r.panels[0], block, ctx, first)
        let unseated
        if (!r.panels[0].passed) {
          const wider = widerStage(first, r.panels[0])
          if (r.panels[1]) checkRuling(r.panels[1], block, ctx, wider)
          else {
            unseated = unseatable(wider, ctx, block.parent)
            if (!unseated) reject('amendment-result', `${a.id} ${r.stage}: a wider panel can be seated, so a ruling below the bar must go to it`)
          }
        }
        if (r.panels.length > (r.panels[0].passed ? 1 : 2)) reject('amendment-result', `${a.id} ${r.stage}: too many panels`)
        const { result, reasons } = stageResult(r.stage, a, r.panels, { unseated, earlier })
        want = { ...head, stage: r.stage, cites: last.id, result, reasons, panels: r.panels, ...(unseated ? { unseated } : {}), ...(r.stage === 'challenge' ? { filings: r.filings } : {}) }
      }
      if (!passes(want)) want.escrow = escrowUse(a, [...entries, { record: want }], p)
    } else if (r.stage === 'seal') {
      want = { ...head, stage: 'seal', cites: last.id, result: 'sealed', cited: ['block:0', a.target, ...entries.map(x => x.id)], effective: block.height + 1 }
      want.escrow = escrowUse(a, [...entries, { record: want }], p)
    }
    if (!same(want, r)) reject('amendment-result', `${a.id} ${r.stage} is not what its panels and the rules give (expected ${want.result})`)
    for (const x of r.panels ?? []) out.panels.push({ id: rulingId(x), ruling: x })
    const list = added.get(a.id) ?? []
    list.push({ record: r, id: recordId(r), height: block.height, time: block.time, ...(screening ? { screening } : {}) })
    added.set(a.id, list)
  }
}

function checkRuling(ruling, block, ctx, given) {
  // `given`: a panel's contract (ethics screening or amendment stage), rebuilt by the verifier, not read from the mempool.
  const found = given ? { entry: { status: 'pending' }, asc: given } : ctx.contract(ruling?.ascHash)
  if (!found) reject('unknown-contract', `contract ${ruling.ascHash} is not in this node's mempool`)
  const { entry, asc } = found
  if (entry.status !== 'pending') reject('already-ruled', `contract ${asc.id} was already ${entry.status}`)
  if (hashAsc(asc) !== ruling?.ascHash) reject(given ? (asc.gate ? 'ethics-gate' : 'amendment-result') : 'unknown-contract', given ? `the ${asc.id} panel ruled on another contract than the one its rules give` : 'contract hash does not match')
  const problems = validate(asc)
  if (problems.length) reject('contract', problems.join('; '))
  if (asc.review && !given) {
    const problem = challengeProblem(asc, ctx.ruling)
    if (problem) reject('review', problem)
  }

  // Context is evidence: every pin is checked against bytes this node holds.
  const loaded = loadContext(asc)
  if (!loaded.ok) reject('context', loaded.problems.join('; '))
  if (canonical(ruling.contextHashes) !== canonical(asc.context.map(c => c.sha256))) reject('context', 'ruling cites context hashes the contract did not pin')

  // Juries span labs, and are drawn from the parent block hash.
  const round = ruling.round
  if (!round || !Array.isArray(round.jury) || !Array.isArray(round.commits) || !Array.isArray(round.reveals)) reject('round', 'ruling carries no commit and reveal record')
  const rules = asc.payment.jury
  const jury = round.jury.map(c => {
    const card = ctx.harnesses.get(c?.id) ?? reject('jury-unknown', `juror ${c?.id} is not registered`)
    if (card.publicKey !== c.publicKey || card.lab !== c.lab || card.model !== c.model || Number(card.bond) !== Number(c.bond) || (card.modelCommitment ?? null) !== (c.modelCommitment ?? null)) reject('jury-unknown', `juror ${c.id} card does not match its registration`)
    return card
  })
  if (jury.length !== rules.size) reject('jury-size', `jury has ${jury.length} seats, the contract asks for ${rules.size}`)
  const labs = new Set(jury.map(c => c.lab))
  if (labs.size < rules.minLabs) reject('jury-labs', `jury spans ${labs.size} labs; the contract requires ${rules.minLabs}`)
  const allowed = new Set(eligibleJurors(jury, asc).map(c => c.id))
  for (const c of jury) if (!allowed.has(c.id)) reject('jury-bond', `${c.id} (bond ${c.bond}, lab ${c.lab}) may not sit on this jury`)
  const seed = block.parent
  if (round.seed !== seed) reject('jury-draw', 'jury seed is not the parent block hash')
  const pool = eligibleJurors([...ctx.harnesses.values()], asc)
  let drawn
  try { drawn = drawJuryFor(asc, pool, seed).map(h => h.id) } catch (err) { reject('jury-draw', err.message) }
  if (canonical(drawn) !== canonical(jury.map(c => c.id))) reject('jury-draw', `jury is not the draw seeded by the parent hash (expected ${drawn.join(', ')})`)

  // Commitments: signed by the registered key, for this contract.
  const byId = new Map(jury.map(c => [c.id, c]))
  const commits = new Map()
  for (const c of round.commits) {
    const card = byId.get(c?.harness) ?? reject('commit', `${c?.harness} is not on this jury`)
    if (commits.has(c.harness)) reject('commit', `${c.harness} committed twice`)
    const problem = checkCommit(card, c, ruling.ascHash)
    if (problem) reject('commit', `${c.harness}: ${problem}`)
    const seen = ctx.seenCommitment?.(ruling.ascHash, c.harness)
    if (seen && seen !== c.commitment) reject('commit-equivocation', `${c.harness} gossiped a different commitment`)
    commits.set(c.harness, c)
  }

  // Reveals must match their commitments.
  for (const r of round.reveals) {
    const c = commits.get(r?.harness) ?? reject('reveal-mismatch', `${r?.harness} revealed without committing`)
    const problem = checkRevealRecord(byId.get(r.harness), c, r, ruling.ascHash)
    if (problem) reject('reveal-mismatch', `${r.harness}: ${problem}`)
  }

  // Exits are declared: the jury can only choose a declared outcome.
  const declared = asc.exits.map(e => e.outcome)
  if (!declared.includes(ruling.exit)) reject('exit-undeclared', `exit "${ruling.exit}" is not declared by the contract`)
  if (asc.question.answer.type !== 'forecast') {
    for (const r of round.reveals) if (!asc.question.answer.options.includes(r.vote.answer)) reject('exit-undeclared', `${r.harness} voted "${r.vote.answer}", not a declared option`)
    if (ruling.passed && ruling.exit !== ruling.answer) reject('exit-undeclared', `exit "${ruling.exit}" does not match answer "${ruling.answer}"`)
  }
  if (!ruling.passed && ruling.exit !== BELOW_BAR) reject('exit-undeclared', `a ruling below the bar must take "${BELOW_BAR}"`)

  // Diffs conserve.
  if (!Array.isArray(ruling.diff) || !conserves(ruling.diff)) reject('diff-conserve', 'diff does not conserve totals')

  // Pay every counted vote, dissent included. Below the bar, pay nobody and carry the escrow.
  // The sealer is paid as the node that sealed this block, never as a harness.
  const account = sealerAccount(block.sealer)
  if (round.sealer !== account) reject('pay', `the round pays the sealer as ${round.sealer}, not ${account}`)
  const unpaid = checkPay(asc, ruling, account)
  if (unpaid.length) reject('pay', unpaid.join('; '))

  // Core re-verifies the whole ruling from its round, and must agree.
  const verdict = verifyRuling(asc, ruling, { cards: ctx.harnesses, pool, seed, verifiers: ctx.validators })
  if (!verdict.ok) reject('replay', `core does not verify the ruling: ${verdict.problems.join('; ')}`)

  const carried = ruling.passed ? 0 : asc.payment.escrow
  return { asc, settlement: { ascHash: ruling.ascHash, status: ruling.passed ? 'ruled' : 'escalated', carried, context: ruling.contextHashes } }
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
