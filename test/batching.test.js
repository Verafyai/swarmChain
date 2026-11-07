// MASTER_SPEC Part C checks on an in-process devnet (three nodes, five harnesses,
// scripted answers): when an L2 block closes, the encrypted queue, the cost split.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sealContract, createQueueKey, openShare, openContract, ascHash, canonical, signMessage, queueMeta, contractTokens, sha256, drawJuryFor, drawJury } from '#core'
import { estimate } from '#economics'
import { network, example, reseal } from './helpers.js'
import { loadChainConfig, batchParams, costSplit } from '../packages/node/src/batch.js'
import { DRAW_KIND } from '../packages/node/src/node.js'

const P = batchParams(loadChainConfig())
const HOUR = 3600 * 1000

/** An L2 version of an example contract, with payment overrides. */
function l2(name, payment = {}) {
  const asc = example(name)
  return { ...asc, payment: { ...asc.payment, ...payment, jury: { ...asc.payment.jury, assurance: 'L2' } } }
}

async function setup() {
  const clock = { now: Date.now() }
  const net = await network({ clock })
  const calls = []
  for (const n of net.nodes) {
    const inner = n.jurors
    n.jurors = { commit: (e, asc) => { calls.push({ harness: e.card.id, asc: asc.id }); return inner.commit(e, asc) }, reveal: inner.reveal }
  }
  const committee = net.nodes[0].committee()
  let refs = 0
  const queue = async (asc, opts = {}) => {
    const env = sealContract(asc, committee.nodes, { t: committee.t, escrowRef: `solana:devnet/escrow-${++refs}`, ...opts })
    return { env, id: await net.nodes[refs % 3].submitSealed(env), asc }
  }
  return { net, clock, calls, committee, queue, advance: ms => { clock.now += ms } }
}

const heights = net => net.nodes.map(n => n.tip()?.height ?? 0)

test('a funded queue below the value threshold does not close', async () => {
  const { net, queue, calls } = await setup()
  for (const name of ['market-resolution', 'fact-check', 'forecast']) await queue(l2(name))
  for (let i = 0; i < 6; i++) assert.equal(await net.step(), null)
  assert.deepEqual(heights(net), [0, 0, 0])
  const s = net.nodes[0].queueStatus()
  assert.equal(s.close, false)
  assert.equal(s.value.met, false)
  assert.ok(s.value.fixedPct > P.warmupMaxPct, `warm-up is ${s.value.fixedPct.toFixed(1)}% of a three-contract block`)
  assert.equal(s.time.met, false)
  assert.equal(calls.length, 0, 'no juror was asked anything')
  for (const n of net.nodes) assert.deepEqual(n.store.queue().map(q => q.status), ['queued', 'queued', 'queued'])
})

test('the value rule closes a block once warm-up is at most 10% and the escrow covers cost plus margin', async () => {
  const { net, queue } = await setup()
  // Declared size: 150 proven requests per contract (illustrative), so 3 contracts are 450 per juror, over the 432 the rule needs.
  const tokens = 150 * 1024
  for (const name of ['market-resolution', 'fact-check']) await queue(l2(name, { escrow: 30 }), { tokens })
  assert.equal(await net.step(), null, 'two contracts are not enough')
  const thin = await queue(l2('forecast', { escrow: 0.8 }), { tokens })
  assert.equal(net.nodes[0].queueStatus().value.fixedPct <= 10, true)
  assert.equal(net.nodes[0].queueStatus().value.met, false, 'warm-up share is met, but the escrow does not cover the block plus margin')
  assert.equal(await net.step(), null)
  await queue(l2('delay-cover', { escrow: 30 }), { tokens })
  const s = net.nodes[0].queueStatus()
  assert.equal(s.reason, 'value')
  const block = await net.step()
  assert.equal(block.rulings.length, 4)
  assert.deepEqual(heights(net), [1, 1, 1])
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)
  assert.ok(block.rulings.some(r => r.ascHash === ascHash(thin.asc)))
})

test('maxWaitSeconds closes it: the chain default (3,600 s, illustrative), or a contract\'s own', async () => {
  const { net, queue, advance } = await setup()
  for (const name of ['market-resolution', 'fact-check']) await queue(l2(name))
  advance(HOUR - 5_000 - P.clockSkewSeconds * 1000)
  assert.equal(await net.step(), null, 'not yet')
  advance(5_000 + P.clockSkewSeconds * 1000)
  const s = net.nodes[0].queueStatus()
  assert.equal(s.reason, 'time')
  const block = await net.step()
  assert.equal(block.rulings.length, 2)
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)

  // A contract that sets its own, shorter wait pays more of the fixed cost, and seals sooner.
  await queue(l2('forecast', { maxWaitSeconds: 120 }))
  advance(60_000 - P.clockSkewSeconds * 1000 - 1)
  assert.equal(await net.step(), null)
  advance(60_001 + P.clockSkewSeconds * 1000)
  const alone = await net.step()
  assert.equal(alone.rulings.length, 1)
  assert.equal(alone.height, 2)
})

test('minBatch holds even when the time rule fires, and a block smaller than a member\'s minBatch is rejected', async () => {
  const { net, queue, advance } = await setup()
  const big = await queue(l2('market-resolution', { minBatch: 5 }))
  await queue(l2('fact-check', { minBatch: 2 }))
  await queue(l2('forecast', { minBatch: 2 }))
  advance(2 * HOUR)
  const sealer = net.sealer()
  const block = await sealer.prepareBlock()
  assert.equal(block.rulings.length, 2, 'the minBatch 5 contract waits')
  assert.ok(!block.rulings.some(r => r.ascHash === ascHash(big.asc)))
  for (const n of net.nodes) await assert.rejects(n.accept(reseal(sealer, [block.rulings[0]])), err => err.code === 'batch-min')
  for (const n of net.nodes) await n.accept(block)
  assert.deepEqual(net.nodes.map(n => n.store.sealed(big.id).status), ['queued', 'queued', 'queued'])
})

test('decryption happens only after the jury draw: no node releases a share before it, or for a draw it cannot check', async () => {
  const { net, queue, advance } = await setup()
  const a = await queue(l2('market-resolution'))
  const b = await queue(l2('fact-check'))
  const [n1, n2, n3] = net.nodes
  // Before any draw, no node holds the plaintext anywhere.
  for (const n of net.nodes) {
    assert.equal(n.store.contracts().length, 0)
    assert.equal(n.storage.get(sha256(canonical(a.asc))), null)
    assert.equal(n.storage.get(a.asc.context[0].sha256), null)
    assert.ok(!canonical(n.store.queue()).includes(a.asc.question.prompt))
  }
  const parent = '0'.repeat(64)
  const pool = n1.store.harnesses().map(e => e.card)
  const juryOf = x => drawJuryFor({ payment: { jury: x.env.meta.jury } }, pool, parent).map(h => h.id)
  const sign = (signer, payload) => ({ ...payload, signature: signMessage(signer.identity.privateKey, payload) })
  // Part G: the draw names each member's screening panel too, drawn from the same seed before any share is released.
  const panel = drawJury(pool, n1.ethics.panel, parent).map(h => h.id)
  const good = { kind: DRAW_KIND, height: 1, seed: parent, sealer: 'node-1', time: new Date().toISOString(), members: [a, b].map(x => ({ queueId: x.id, jury: juryOf(x), screening: panel })) }
  // Not yet due: no close rule holds on the peer's own view.
  assert.throws(() => n2.releaseShare(sign(n1, good)), /share withheld: no close rule holds/)
  advance(2 * HOUR)
  assert.throws(() => n2.releaseShare(sign(n1, { ...good, seed: 'f'.repeat(64) })), /drawn from the parent block hash/)
  assert.throws(() => n2.releaseShare(sign(n3, { ...good, sealer: 'node-3' })), /not node-3's turn/)
  assert.throws(() => n2.releaseShare(sign(n3, good)), /signature does not verify/)
  assert.throws(() => n2.releaseShare(sign(n1, { ...good, members: [{ queueId: a.id, jury: juryOf(a).slice(1) }] })), /not the draw seeded by the parent hash/)
  assert.throws(() => n2.releaseShare(sign(n1, { ...good, height: 2 })), /draw is for height 2/)
  assert.throws(() => n2.releaseShare(sign(n1, { ...good, members: good.members.map(m => ({ ...m, screening: panel.slice(1) })) })), /screening panel .* is not the draw seeded by the parent hash/)

  const events = []
  for (const n of net.nodes) { const log = n.log; n.log = e => { events.push(e); log(e) } }
  const block = await net.step()
  assert.equal(block.rulings.length, 2)
  for (const r of block.rulings) assert.equal(r.round.seed, parent, 'juries drawn from the parent hash')
  const order = events.map(e => e.event)
  const released = order.indexOf('shares-released')
  const opened = order.indexOf('queue-opened')
  const sealed = order.indexOf('block')
  assert.ok(released >= 0 && released < opened && opened < sealed, order.join(', '))
  assert.equal(events.filter(e => e.event === 'shares-released').length, 3, 'every node checks the draw itself before it releases; any two of the three shares open it')
  // Revealed: plaintext and pins are in every node's availability layer.
  for (const n of net.nodes) {
    assert.equal(n.storage.get(sha256(canonical(a.asc))), canonical(a.asc))
    for (const c of a.asc.context) assert.equal(n.storage.get(c.sha256), c.content)
    assert.deepEqual(n.store.queue().map(q => q.status), ['opened', 'opened'])
  }
})

test('a juror cannot read a queued contract before the draw', async () => {
  const { net, queue, calls, advance } = await setup()
  const { env, asc } = await queue(l2('market-resolution'))
  assert.equal(calls.length, 0)
  // The envelope is public; a harness holds no share, and its own key opens nothing.
  const juror = createQueueKey()
  for (const node of ['node-1', 'node-2', 'node-3']) assert.throws(() => openShare(env, node, juror.privateKey))
  const text = canonical(env)
  for (const secret of [asc.question.prompt, asc.instructions, asc.context[1].content, ascHash(asc)]) assert.ok(!text.includes(secret))
  // A juror colluding with one node still has one share of the two needed.
  const one = openShare(env, 'node-2', net.nodes[1].queueKey.privateKey)
  assert.throws(() => openContract(env, [one]), /need 2 shares/)
  // And the nodes give the jurors nothing until the block closes.
  for (let i = 0; i < 3; i++) await net.step()
  assert.equal(calls.length, 0)
  advance(2 * HOUR)
  await net.step()
  // The screening panel reads it first (Part G), then the five drawn jurors, both only after the draw.
  assert.deepEqual(calls.filter(c => c.asc === asc.id).length, 5, 'the five drawn jurors read it only after the draw')
  assert.deepEqual(calls.slice(0, 3).map(c => c.asc), Array(3).fill(`ethics/${asc.id}`), 'the screening panel reads it before the jury')
})

test('cost shares sum to the block cost, pro rata by proven requests, and match packages/economics', async () => {
  // 24 contracts of 800 tokens: the B4 vector, $7.50 per block and $0.3127 per contract (modeled).
  const meta = tokens => ({ escrow: 1, currency: 'USDC', jury: { size: 5, minLabs: 5, assurance: 'L2' }, tokens })
  const uniform = costSplit(Array.from({ length: 24 }, (_, i) => ({ id: `c${i}`, meta: meta(800) })), P)
  assert.equal(uniform.blockCostUsd.toFixed(4), estimate({}).blockCostUsd.toFixed(4))
  assert.equal(uniform.blockCostUsd.toFixed(2), '7.50')
  assert.equal(uniform.shares[0].shareUsd.toFixed(4), '0.3127')
  assert.equal(uniform.shares.reduce((s, x) => s + x.shareMicroUsd, 0), uniform.totalMicroUsd)
  // Mixed sizes: a 4,000-token contract is 4 proven requests per juror, and pays four times a 800-token one.
  const mixed = costSplit([{ id: 'small', meta: meta(800) }, { id: 'large', meta: meta(4000) }, { id: 'small2', meta: meta(900) }], P)
  assert.deepEqual(mixed.shares.map(s => s.requests), [1, 4, 1])
  assert.equal(mixed.shares.reduce((s, x) => s + x.shareMicroUsd, 0), mixed.totalMicroUsd)
  assert.equal(mixed.totalMicroUsd, Math.round(mixed.blockCostUsd * 1e6))
  assert.ok(Math.abs(mixed.shares[1].shareMicroUsd - 4 * mixed.shares[0].shareMicroUsd) <= 4)

  // On the devnet: the block's split, from the clear metadata, sums to its modeled cost.
  const { net, queue, advance } = await setup()
  await queue(l2('market-resolution'))
  await queue(l2('fact-check'), { tokens: 3000 })
  advance(2 * HOUR)
  const block = await net.step()
  for (const n of net.nodes) {
    const split = n.costSplit(block)
    assert.equal(split.shares.length, 2)
    assert.equal(split.shares.reduce((s, x) => s + x.shareMicroUsd, 0), split.totalMicroUsd)
    assert.equal(split.totalMicroUsd, Math.round(split.blockCostUsd * 1e6))
    assert.equal(split.label, 'modeled')
  }
})

test('totals are conserved: escrow queued = escrow ruled in the block + escrow still queued, and every diff conserves', async () => {
  const { net, queue, advance } = await setup()
  const entries = [
    await queue(l2('market-resolution')),
    await queue(l2('fact-check')),
    await queue(l2('forecast', { minBatch: 9 })),
    await queue(l2('delay-cover')),
  ]
  const queuedBefore = entries.reduce((s, e) => s + e.env.meta.escrow, 0)
  advance(2 * HOUR)
  const block = await net.step()
  assert.equal(block.rulings.length, 3)
  const debited = block.rulings.reduce((s, r) => s - r.diff.filter(d => d.account.startsWith('escrow:') && d.delta < 0).reduce((a, d) => a + d.delta, 0), 0)
  const stillQueued = net.nodes[0].store.queue('queued').reduce((s, q) => s + q.meta.escrow, 0)
  assert.ok(Math.abs(queuedBefore - (debited + stillQueued)) < 1e-9, `${queuedBefore} = ${debited} + ${stillQueued}`)
  for (const r of block.rulings) assert.ok(Math.abs(r.diff.reduce((s, d) => s + d.delta, 0)) < 1e-9)
  assert.ok(Math.abs(block.rulings.flatMap(r => r.diff).reduce((s, d) => s + d.delta, 0)) < 1e-9, 'the block conserves')
  for (const r of block.rulings) {
    const e = entries.find(x => ascHash(x.asc) === r.ascHash)
    assert.equal(e.asc.payment.escrow, e.env.meta.escrow, 'the clear escrow is the escrow the ruling splits')
  }
})

test('L1 does not batch: an L1 contract from the queue seals alone at once, and an L2 contract cannot skip the queue', async () => {
  const { net, queue } = await setup()
  await queue(l2('market-resolution'))
  const l1 = await queue(example('fact-check'))
  const block = await net.step()
  assert.equal(block.rulings.length, 1)
  assert.equal(block.rulings[0].ascHash, ascHash(l1.asc))
  await assert.rejects(net.nodes[0].submit(l2('forecast')), /enter through the encrypted queue/)
})

test('a quote is shown before funding: the share now, at the value rule, and alone', async () => {
  const { net } = await setup()
  const asc = l2('market-resolution')
  const q = net.nodes[0].quote(queueMeta(asc, { escrowRef: 'quote', tokens: 800 }))
  assert.equal(q.label, 'modeled')
  assert.equal(q.requests, 1)
  assert.equal(q.atValueRule.contracts, estimate({}).minRequestsForWarmup, 'the value rule closes at minRequestsForWarmup')
  assert.ok(q.ifClosedNow.shareUsd > q.atValueRule.shareUsd)
  assert.equal(q.maxWaitSeconds, 3600)
  assert.equal(net.nodes[0].quote(queueMeta(example('fact-check'), { escrowRef: 'q' })).batched, false)
  assert.ok(contractTokens(asc) < 800)
})

test('chain parameters are frozen at load; they change only by amendment', () => {
  const config = loadChainConfig()
  assert.ok(Object.isFrozen(config.batching.L2.maxWaitSeconds))
  assert.throws(() => { config.batching.L2.maxWaitSeconds.value = 1 })
  assert.equal(config.batching.L2.maxWaitSeconds.label, 'illustrative')
  assert.equal(config.batching.L2.warmupMaxPct.value, 10)
  assert.equal(config.batching.L1.batch.value, false)
})
