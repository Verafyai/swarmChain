/**
 * Batching: when an L2 block closes, and who pays what share of it.
 *
 * A block of L2 contracts closes when either is true:
 *   value   the queue is big enough that the block's fixed cost (warm-up plus
 *           the idle reserve) is at most `warmupMaxPct` of the block's modeled
 *           cost, and its funded escrow covers that cost plus margin
 *   time    some queued contract has waited its `maxWaitSeconds` (its own, or
 *           the chain default)
 * A contract with `minBatch` never seals in a block with fewer contracts.
 * L1 contracts do not batch: each seals as soon as a jury rules.
 *
 * Every cost is modeled by `estimate()` from verafyHarness `packages/economics`;
 * nothing here re-derives a formula. The split is pro rata by proven requests
 * (a contract's requests times its jury size), in whole micro-dollars by largest
 * remainder, so the shares sum exactly to the block cost.
 *
 * Parameters come from `config/chain.json`, frozen at load. They are proposed,
 * illustrative values, and change only by amendment.
 * @module swarmchain/node/batch
 */
import { readFileSync } from 'node:fs'
import { estimate, PRESETS } from '#economics'

export const CHAIN_CONFIG_FILE = new URL('../../../config/chain.json', import.meta.url)

/** Assurance levels that batch. */
export const BATCHED_LEVELS = ['L2', 'L3']

const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }

/**
 * Load the chain config, frozen.
 * @param {string | URL} [file] - the config file.
 * @returns {object} the config, with each parameter's value, label and source.
 */
export function loadChainConfig(file = CHAIN_CONFIG_FILE) {
  return deepFreeze(JSON.parse(readFileSync(file, 'utf8')))
}

/**
 * Plain parameter values from the config.
 * @param {object} config - the chain config.
 * @returns {{warmupMaxPct: number, maxWaitSeconds: number, idleReserveUsd: number, usdPerUnit: object, threshold: string, clockSkewSeconds: number, econ: object}} parameters.
 */
export function batchParams(config) {
  const l2 = config.batching.L2
  const preset = PRESETS[l2.preset.value]
  if (!preset) throw new Error(`unknown economics preset "${l2.preset.value}"`)
  return {
    warmupMaxPct: l2.warmupMaxPct.value,
    maxWaitSeconds: l2.maxWaitSeconds.value,
    idleReserveUsd: l2.idleReserveUsd.value,
    usdPerUnit: config.usdPerUnit.value,
    threshold: config.queue.threshold.value,
    clockSkewSeconds: config.queue.clockSkewSeconds.value,
    // Batching models unpacked proving: every request of every contract is proven by every juror.
    econ: { ...preset.values, packing: false, atomize: false, proveOnce: false },
  }
}

/**
 * Shares needed to open a queued contract.
 * @param {number} n - nodes in the set.
 * @param {string} rule - `majority`.
 * @returns {number} t.
 */
export function thresholdFor(n, rule = 'majority') {
  if (rule !== 'majority') throw new Error(`unknown threshold rule "${rule}"`)
  return Math.floor(n / 2) + 1
}

/**
 * Whether a contract (or its clear metadata) batches.
 * @param {{jury?: {assurance?: string}, payment?: {jury?: {assurance?: string}}}} x - clear metadata or a contract.
 * @returns {boolean} true for L2 and L3.
 */
export function isBatched(x) {
  const level = x?.jury?.assurance ?? x?.payment?.jury?.assurance
  return BATCHED_LEVELS.includes(level)
}

/**
 * Proven requests one contract needs from one juror, from its declared size.
 * @param {{tokens: number}} meta - clear metadata.
 * @param {object} econ - economics inputs.
 * @returns {number} requests.
 */
export function requestsFor(meta, econ) {
  return estimate({ ...econ, contracts: 1, tokensPerContract: meta.tokens }).requestsPerContract
}

/**
 * The modeled cost of one block holding these contracts.
 * @param {{meta: object}[]} items - queued contracts.
 * @param {object} p - batch parameters.
 * @returns {object} proofs, provers, and the cost broken into variable and fixed parts (US dollars, modeled).
 */
export function blockCost(items, p) {
  const { econ } = p
  const perContract = items.map(it => ({ ...it, requests: requestsFor(it.meta, econ), jurors: it.meta.jury.size }))
  const proofs = perContract.reduce((s, c) => s + c.requests * c.jurors, 0)
  const provers = Math.max(0, ...perContract.map(c => c.jurors))
  // Proving, verifying and storing every proof: one prover over `proofs` requests.
  const { contextTokens } = estimate(econ).inputs
  const work = proofs ? estimate({ ...econ, jurors: 1, contracts: 1, tokensPerContract: proofs * contextTokens }) : null
  const variableUsd = work ? work.parts.proving + work.parts.verifying + work.parts.storing : 0
  // Warm-up: every juror's prover loads weights once per block.
  const warmupUsd = provers ? estimate({ ...econ, jurors: provers }).parts.warmup : 0
  const fixedUsd = warmupUsd + (items.length ? p.idleReserveUsd : 0)
  const blockCostUsd = variableUsd + fixedUsd
  const marginPct = estimate(econ).inputs.marginPct
  return { contracts: items.length, perContract, proofs, provers, variableUsd, warmupUsd, idleReserveUsd: items.length ? p.idleReserveUsd : 0, fixedUsd, blockCostUsd, marginPct, label: 'modeled' }
}

/**
 * Split a block's modeled cost across its contracts, pro rata by proven requests.
 * Shares are whole micro-dollars (largest remainder) and sum exactly to the block cost.
 * @param {{id: string, meta: object}[]} items - the block's contracts.
 * @param {object} p - batch parameters.
 * @returns {object} the block cost and each contract's share.
 */
export function costSplit(items, p) {
  const cost = blockCost(items, p)
  const totalMicroUsd = Math.round(cost.blockCostUsd * 1e6)
  const raw = cost.perContract.map(c => (cost.proofs ? c.requests * c.jurors / cost.proofs : 0) * totalMicroUsd)
  const micro = raw.map(Math.floor)
  let left = totalMicroUsd - micro.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) micro[order[k][1]]++
  const m = 1 + cost.marginPct / 100
  const shares = cost.perContract.map((c, i) => ({
    id: c.id, requests: c.requests, jurors: c.jurors, provenRequests: c.requests * c.jurors,
    shareMicroUsd: micro[i], shareUsd: micro[i] / 1e6, priceUsd: micro[i] / 1e6 * m,
  }))
  const { perContract, ...rest } = cost
  return { ...rest, totalMicroUsd, shares }
}

/**
 * Escrow in the queue, in US dollars, counting only currencies with a set rate.
 * @param {{meta: object}[]} items - queued contracts.
 * @param {object} p - batch parameters.
 * @returns {number} US dollars.
 */
export function fundedUsd(items, p) {
  return items.reduce((s, it) => s + it.meta.escrow * (p.usdPerUnit[it.meta.currency] ?? 0), 0)
}

/**
 * Drop contracts whose `minBatch` the set cannot meet, until every remaining one is met.
 * @param {{meta: object}[]} items - candidates.
 * @returns {{meta: object}[]} the contracts that may seal together.
 */
export function withinMinBatch(items) {
  let s = items
  for (;;) {
    const next = s.filter(it => (it.meta.minBatch ?? 1) <= s.length)
    if (next.length === s.length) return s
    s = next
  }
}

/**
 * Evaluate the close rules for a set of L2 contracts, as they stand.
 * @param {{id: string, meta: object, receivedAt: number}[]} items - the candidate block, already within minBatch.
 * @param {{now: number, p: object}} options - the clock (ms) and parameters.
 * @returns {object} `close`, `reason`, and the value and time readings behind them.
 */
export function evaluate(items, { now, p }) {
  if (!items.length) return { close: false, reason: null, members: [] }
  const split = costSplit(items, p)
  const funded = fundedUsd(items, p)
  const neededUsd = split.blockCostUsd * (1 + split.marginPct / 100)
  const fixedPct = split.blockCostUsd ? 100 * split.fixedUsd / split.blockCostUsd : 100
  const value = { met: fixedPct <= p.warmupMaxPct && funded >= neededUsd, fixedPct, warmupMaxPct: p.warmupMaxPct, fundedUsd: funded, neededUsd }
  const waits = items.map(it => ({ id: it.id, waitedSeconds: (now - it.receivedAt) / 1000, limitSeconds: it.meta.maxWaitSeconds ?? p.maxWaitSeconds }))
  const due = waits.filter(w => w.waitedSeconds >= w.limitSeconds)
  const time = { met: due.length > 0, due: due.map(w => w.id), oldestWaitSeconds: Math.max(...waits.map(w => w.waitedSeconds)), nextDueSeconds: Math.min(...waits.map(w => w.limitSeconds - w.waitedSeconds)) }
  return { close: value.met || time.met, reason: value.met ? 'value' : time.met ? 'time' : null, members: items.map(it => it.id), value, time, split }
}

/**
 * Decide the next block from the queue: the oldest L1 contract alone, or the
 * L2 contracts that may seal together, if a close rule holds.
 * @param {{id: string, meta: object, receivedAt: number}[]} queue - queued contracts, oldest first.
 * @param {{now: number, p: object}} options - the clock and parameters.
 * @returns {object} the decision, with `members` to open when `close` is true.
 */
export function closeDecision(queue, { now, p }) {
  const l1 = queue.find(it => !isBatched(it.meta))
  if (l1) return { close: true, reason: 'L1', members: [l1.id] }
  return evaluate(withinMinBatch(queue.filter(it => isBatched(it.meta))), { now, p })
}

/**
 * The check a node runs before it releases its shares: does this member set,
 * as the sealer proposes it, meet a close rule on this node's own view?
 * @param {{id: string, meta: object, receivedAt: number}[]} members - the proposed block, as this node holds it.
 * @param {{now: number, p: object}} options - this node's clock and parameters.
 * @returns {string | null} the problem, or null.
 */
export function closeProblem(members, { now, p }) {
  if (!members.length) return 'no contracts to open'
  const l1 = members.filter(it => !isBatched(it.meta))
  if (l1.length) return members.length === 1 ? null : 'an L1 contract seals alone'
  if (withinMinBatch(members).length !== members.length) return 'a member\'s minBatch is larger than the block'
  const e = evaluate(members, { now: now + p.clockSkewSeconds * 1000, p })
  return e.close ? null : `no close rule holds: fixed cost ${e.value.fixedPct.toFixed(1)}% of the block (rule: at most ${p.warmupMaxPct}%), funded $${e.value.fundedUsd.toFixed(4)} against $${e.value.neededUsd.toFixed(4)} needed, and no contract has waited its maximum`
}

/**
 * A quote for a contract author, before funding: its share if the block closed
 * with the queue as it stands, and at the size where the value rule closes it.
 * @param {object} meta - the contract's clear metadata (`queueMeta` in core).
 * @param {{id: string, meta: object}[]} queue - L2 contracts queued now.
 * @param {object} p - batch parameters.
 * @returns {object} the quote, labeled modeled.
 */
export function quote(meta, queue, p) {
  if (!isBatched(meta)) return { batched: false, note: 'L1 contracts do not batch. They seal as soon as a jury rules, and pay no proving cost.', label: 'illustrative' }
  const me = { id: 'quote', meta }
  const others = queue.filter(it => isBatched(it.meta))
  const set = withinMinBatch([...others, me])
  const now = costSplit(set.includes(me) ? set : [me], p)
  const mine = now.shares.find(s => s.id === 'quote')
  // The smallest block of contracts like this one that meets the value rule
  // (doubling, then bisecting; null when no size up to a million meets it).
  const valueAt = n => evaluate(Array.from({ length: n }, (_, i) => ({ id: i ? `like-${i}` : 'quote', meta, receivedAt: 0 })), { now: 0, p: { ...p, maxWaitSeconds: Infinity } })
  let atValue = null
  let hi = 1
  while (hi < 1_000_000 && !valueAt(hi).value.met) hi *= 2
  if (valueAt(hi).value.met) {
    let lo = Math.floor(hi / 2)
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (valueAt(mid).value.met) hi = mid; else lo = mid }
    const e = valueAt(hi)
    const s = e.split.shares[0]
    atValue = { contracts: hi, blockCostUsd: e.split.blockCostUsd, shareUsd: s.shareUsd, priceUsd: s.priceUsd }
  }
  const waitSeconds = meta.maxWaitSeconds ?? p.maxWaitSeconds
  const worst = costSplit([me], p).shares[0]
  return {
    batched: true,
    requests: mine.requests,
    jurors: mine.jurors,
    provenRequests: mine.provenRequests,
    ifClosedNow: { contracts: now.contracts, blockCostUsd: now.blockCostUsd, shareUsd: mine.shareUsd, priceUsd: mine.priceUsd },
    atValueRule: atValue,
    alone: { blockCostUsd: worst.shareUsd, priceUsd: worst.priceUsd, note: 'if the time rule seals it in a block of one' },
    maxWaitSeconds: waitSeconds,
    minBatch: meta.minBatch ?? 1,
    marginPct: now.marginPct,
    escrowCoversAlone: meta.escrow * (p.usdPerUnit[meta.currency] ?? 0) >= worst.priceUsd,
    label: 'modeled',
    note: 'Modeled with packages/economics (L2, FlashProve, unpacked preset). The split is pro rata by proven requests. Chain parameters are illustrative until fixed by amendment.',
  }
}
