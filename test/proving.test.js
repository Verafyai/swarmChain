// MASTER_SPEC Part D5 checks on an in-process devnet (three nodes, five
// harnesses with the mock prover, scripted answers): L2 proofs, finality, the
// proof deadline, faults against bonds, escalation, and hashes only on chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sealContract, ascHash, finality, proofCheck, createIdentity, mockProvider } from '#core'
import { mockProver } from '#prove'
import { network, example, reseal, clone, SCRIPT } from './helpers.js'

const HOUR = 3600 * 1000

function l2(name, payment = {}) {
  const asc = example(name)
  return { ...asc, payment: { ...asc.payment, ...payment, jury: { ...asc.payment.jury, assurance: 'L2' } } }
}

/** A network, a queue helper, and one L2 contract sealed into its own block by the time rule. */
async function setup() {
  const clock = { now: Date.now() }
  const net = await network({ clock })
  const committee = net.nodes[0].committee()
  let refs = 0
  const logs = []
  for (const n of net.nodes) { n.proofDeadlineMs = 200; n.log = e => logs.push(e) }
  const sealOne = async asc => {
    const env = sealContract(asc, committee.nodes, { t: committee.t, escrowRef: `solana:devnet/escrow-${++refs}` })
    await net.nodes[refs % 3].submitSealed(env)
    clock.now += 2 * HOUR
    const block = await net.step()
    assert.ok(block, 'the time rule closed a block')
    return { block, ruling: block.rulings[0] }
  }
  /** Close a block from the queue on the sealer, without appending it anywhere. */
  const prepareOne = async asc => {
    const env = sealContract(asc, committee.nodes, { t: committee.t, escrowRef: `solana:devnet/escrow-${++refs}` })
    await net.nodes[0].submitSealed(env)
    clock.now += 2 * HOUR
    const s = net.sealer()
    return { s, block: await s.prepareBlock() }
  }
  return { net, sealOne, prepareOne, logs }
}

const withhold = (net, id) => { net.harnesses.get(id).prove = async () => { throw new Error('withheld') } }

test('an L2 ruling with mock proofs finalizes on every node, with only hashes on chain', async () => {
  const { net, sealOne } = await setup()
  const asc = l2('market-resolution')
  const { block, ruling } = await sealOne(asc)
  assert.equal(ruling.passed, true)
  assert.equal(ruling.votes.length, 5)
  assert.ok(ruling.votes.every(v => /^[0-9a-f]{64}$/.test(v.proofHash)))
  assert.deepEqual(ruling.round.faults, [])
  assert.equal(ruling.round.proofChecks.length, 5)
  assert.ok(ruling.round.proofChecks.every(k => k.ok && k.verifier === block.sealer))
  assert.deepEqual(finality(asc, ruling), { final: true, problems: [] })
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)
  // The bundles live in the sealer's availability layer, by hash, and never in the block.
  const sealer = net.nodes.find(n => n.id === block.sealer)
  const text = JSON.stringify(block)
  for (const r of ruling.round.proofRecords) {
    const bundle = sealer.storage.get(r.proofHash)
    assert.equal(typeof bundle, 'string')
    assert.ok(!text.includes(bundle))
  }
  assert.ok(!text.includes('verafy.proof-bundle/1') && !text.includes('mock/1'))
})

test('one missing proof drops the vote and records a fault against the bond', async () => {
  const { net, sealOne, logs } = await setup()
  withhold(net, 'h-qwen-1')
  const { block, ruling } = await sealOne(l2('market-resolution'))
  assert.equal(ruling.votes.length, 4)
  assert.ok(!ruling.votes.some(v => v.harness === 'h-qwen-1'))
  assert.deepEqual(ruling.round.faults, [{ harness: 'h-qwen-1', fault: 'no-proof' }])
  assert.equal(ruling.passed, true)
  assert.ok(logs.some(e => e.event === 'proof-missed' && e.harness === 'h-qwen-1'))
  for (const n of net.nodes) assert.deepEqual(n.store.faults(), [{ height: block.height, block: block.hash, ascHash: ruling.ascHash, harness: 'h-qwen-1', fault: 'no-proof', bond: 500 }])
})

test('a proof that misses the deadline is a missing proof', async () => {
  const { net, sealOne } = await setup()
  net.harnesses.get('h-meta-1').prove = () => new Promise(() => {})
  const t0 = Date.now()
  const { ruling } = await sealOne(l2('market-resolution'))
  assert.ok(Date.now() - t0 >= 200)
  assert.deepEqual(ruling.round.faults, [{ harness: 'h-meta-1', fault: 'no-proof' }])
})

test('below the bar after the drop, it escalates and carries the escrow', async () => {
  const { net, sealOne } = await setup()
  // fact-check: 0.915 agreement with all five (scripted); 0.891 without anthropic, under a 0.9 bar (illustrative).
  withhold(net, 'h-anthropic-1')
  const asc = l2('fact-check', { bar: 0.9 })
  const { ruling } = await sealOne(asc)
  assert.equal(ruling.agreement, 0.891)
  assert.equal(ruling.passed, false)
  assert.equal(ruling.exit, '*below-bar')
  assert.equal(ruling.triggers[0].type, 'escalate')
  for (const n of net.nodes) assert.equal(n.store.contract(ascHash(asc)).status, 'escalated')
  assert.deepEqual(ruling.round.faults, [{ harness: 'h-anthropic-1', fault: 'no-proof' }])
})

test('a proof for a different model commitment fails verification', async () => {
  const { net, sealOne, logs } = await setup()
  net.harnesses.get('h-google-1').prover = mockProver({ model: 'not-the-committed-model', complete: mockProvider(SCRIPT).complete })
  const { ruling } = await sealOne(l2('delay-cover'))
  const k = ruling.round.proofChecks.find(c => c.harness === 'h-google-1')
  assert.equal(k.ok, false)
  assert.match(k.reason, /does not verify under the model commitment/)
  assert.deepEqual(ruling.round.faults, [{ harness: 'h-google-1', fault: 'bad-proof' }])
  assert.ok(logs.some(e => e.event === 'proof-failed' && e.harness === 'h-google-1'))
  assert.equal(net.nodes[0].store.faults()[0].fault, 'bad-proof')
})

test('peers refuse an L2 block whose proofs are unverified, forged, or on chain', async () => {
  const asc = l2('market-resolution')
  const stranger = createIdentity()
  const cases = [
    ['unverified', r => ({ ...r, round: { ...r.round, proofChecks: [] } }), /not final/],
    ['forged', r => ({ ...r, round: { ...r.round, proofChecks: r.round.proofRecords.map(rec => proofCheck('node-9', stranger.privateKey, rec, { ok: true })) } }), /not a known verifier/],
    ['on chain', r => ({ ...r, round: { ...r.round, proofRecords: r.round.proofRecords.map((rec, i) => i ? rec : { ...rec, proof: 'AAAA' }) } }), /proofs stay off chain/],
  ]
  for (const [name, edit, match] of cases) {
    const { net, prepareOne } = await setup()
    const { s, block: honest } = await prepareOne(asc)
    const block = reseal(s, [edit(clone(honest.rulings[0]))])
    for (const n of net.nodes) await assert.rejects(n.accept(clone(block)), match, `${name} on ${n.id}`)
  }
})
