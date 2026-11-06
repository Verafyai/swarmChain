/**
 * The read API: blocks, rulings with their review history, contracts in the
 * mempool, and harness records. Read only; nothing here writes chain state.
 *
 *   GET /blocks                 block headers, lowest first (?full=1 for whole blocks)
 *   GET /blocks/<height|hash>   one block
 *   GET /rulings                every ruling with its review status
 *   GET /rulings/<id>           one ruling, its votes, dissent, diff and every review
 *   GET /contracts              the mempool: pending, ruled and escalated contracts
 *   GET /contracts/<ascHash>    one contract (context as hashes)
 *   GET /harnesses              registered harnesses with their records
 *   GET /accounts               balances implied by every sealed diff
 *   GET /faults                 faults recorded against bonds (?harness=<id>), such as no-proof and bad-proof
 *
 * A vote's `proofHash`, when present, is a hash only. It is not a proof by
 * itself: it means something only alongside availability, bonds and challenges.
 * @module swarmchain/api
 */
import { reviewStatus as statusOf } from '#core'

/**
 * Build the read API over a node's store.
 * @param {import('../../node/src/store.js').BlockStore} store - the block store.
 * @returns {(req: {method: string, path: string[], query: URLSearchParams}) => ({status: number, body: unknown} | null)} the route handler.
 */
export function readApi(store) {
  const ok = body => ({ status: 200, body })
  const missing = what => ({ status: 404, body: { error: `${what} not found` } })

  function reviewStatus(id) {
    const history = store.reviews(id)
    return { status: statusOf(id, history), reviewedBy: history.at(-1)?.by ?? null, reviewCount: history.length }
  }

  function summary(r) {
    const e = r.ruling
    return { id: r.id, height: r.height, block: r.block, asc: e.asc, ascHash: e.ascHash, answer: e.answer, agreement: e.agreement, bar: e.bar, passed: e.passed, exit: e.exit, votes: e.votes.length, dissent: e.dissent.length, review: reviewStatus(r.id) }
  }

  return function route(req) {
    if (req.method !== 'GET') return null
    const [head, ref, ...rest] = req.path
    if (rest.length) return null
    if (head === 'blocks' && !ref) {
      const blocks = store.blocks()
      return ok(req.query.get('full') ? blocks : blocks.map(b => ({ height: b.height, hash: b.hash, parent: b.parent, sealer: b.sealer, time: b.time, rulings: b.rulings.length })))
    }
    if (head === 'blocks') return store.block(ref) ? ok(store.block(ref)) : missing('block')
    if (head === 'rulings' && !ref) return ok(store.rulings().map(summary))
    if (head === 'rulings') {
      const r = store.ruling(ref)
      if (!r) return missing('ruling')
      const { round, ...ruling } = r.ruling
      return ok({ ...summary(r), ruling, jury: round.jury.map(c => c.id), seed: round.seed, sealer: round.sealer, faults: round.faults, proofRecords: round.proofRecords, reviews: store.reviews(ref) })
    }
    if (head === 'contracts' && !ref) return ok(store.contracts().map(({ asc, ...c }) => ({ ...c, title: asc.title })))
    if (head === 'contracts') return store.contract(ref) ? ok(store.contract(ref)) : missing('contract')
    if (head === 'harnesses' && !ref) return ok(harnessRecords(store))
    if (head === 'accounts' && !ref) return ok(accounts(store))
    if (head === 'faults' && !ref) return ok(store.faults(req.query.get('harness') ?? undefined))
    return null
  }
}

/**
 * Per-harness records read from sealed rulings: votes counted, dissents, and what each was paid.
 * @param {import('../../node/src/store.js').BlockStore} store - the block store.
 * @returns {object[]} one record per registered harness.
 */
export function harnessRecords(store) {
  const rec = new Map(store.harnesses().map(({ card, url }) => [card.id, { ...card, url, seated: 0, counted: 0, dissents: 0, earned: 0 }]))
  for (const { ruling } of store.rulings()) {
    for (const { id } of ruling.round.jury) if (rec.has(id)) rec.get(id).seated++
    for (const v of ruling.votes) if (rec.has(v.harness)) rec.get(v.harness).counted++
    for (const d of ruling.dissent) if (rec.has(d.harness)) rec.get(d.harness).dissents++
    for (const d of ruling.diff) {
      const id = d.account.startsWith('harness:') ? d.account.slice(8) : null
      if (id && rec.has(id)) rec.get(id).earned = Math.round((rec.get(id).earned + d.delta) * 1e6) / 1e6
    }
  }
  return [...rec.values()]
}

/**
 * Balances implied by every sealed diff.
 * @param {import('../../node/src/store.js').BlockStore} store - the block store.
 * @returns {Record<string, number>} account to balance change.
 */
export function accounts(store) {
  const out = {}
  for (const { ruling } of store.rulings()) for (const d of ruling.diff) out[d.account] = Math.round(((out[d.account] ?? 0) + d.delta) * 1e6) / 1e6
  return out
}
