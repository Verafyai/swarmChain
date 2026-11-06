// The chain end to end in one process: three nodes, five harnesses, local gossip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonical, sha256, challengeContract, resolveChallenge } from '#core'
import { network, example, reseal, SCRIPT, FIVE_LABS, SECOND_FIVE } from './helpers.js'
import { readApi, accounts } from '../packages/api/src/index.js'
import { ContextStore } from '../packages/storage/src/index.js'
import { BlockStore, rulingId } from '../packages/node/src/index.js'

const EXAMPLES = ['market-resolution', 'fact-check', 'forecast', 'delay-cover', 'fact-check-escalation']

async function fiveBlocks() {
  const net = await network()
  for (const [i, name] of EXAMPLES.entries()) await net.nodes[i % 3].submit(example(name))
  for (let i = 0; i < EXAMPLES.length; i++) assert.ok(await net.step(), `block ${i + 1} sealed`)
  return net
}

test('five contracts make five blocks, identical on all three nodes, with the sealer rotating', async () => {
  const net = await fiveBlocks()
  const chains = net.nodes.map(n => n.store.blocks())
  for (const ch of chains) assert.equal(ch.length, 5)
  for (let i = 0; i < 5; i++) assert.equal(new Set(chains.map(ch => ch[i].hash)).size, 1)
  assert.deepEqual(chains[0].map(b => b.sealer), ['node-1', 'node-2', 'node-3', 'node-1', 'node-2'])
  for (let i = 1; i < 5; i++) assert.equal(chains[0][i].parent, chains[0][i - 1].hash)
  // Mempool empty: no more blocks.
  assert.equal(await net.step(), null)
})

test('juries are seeded by the parent block hash', async () => {
  const net = await fiveBlocks()
  for (const b of net.nodes[0].store.blocks()) assert.equal(b.rulings[0].round.seed, b.parent)
  const tips = net.nodes.map(n => n.store.blocks().map(b => b.time))
  for (const t of tips[0].slice(1).map((x, i) => [tips[0][i], x])) assert.ok(Date.parse(t[1]) > Date.parse(t[0]), 'seal times increase')
})

test('below the bar: no juror is paid and the whole escrow carries to the escalated jury', async () => {
  const net = await fiveBlocks()
  const asc = example('fact-check-escalation')
  const block = net.nodes[2].store.blocks().find(b => b.rulings[0].asc === asc.id)
  const r = block.rulings[0]
  assert.equal(r.passed, false)
  assert.equal(r.exit, '*below-bar')
  assert.equal(r.diff.filter(d => d.account.startsWith('harness:')).length, 0)
  assert.deepEqual(r.triggers, [{ type: 'escalate', jurySize: 9 }])
  for (const n of net.nodes) {
    const entry = n.store.contracts().find(c => c.id === asc.id)
    assert.equal(entry.status, 'escalated')
    assert.equal(entry.carried, asc.payment.escrow)
    assert.equal(accounts(n.store)[`escrow:${asc.id}:escalation`], asc.payment.escrow)
  }
})

test('every counted vote is paid, dissent included, and paid the same', async () => {
  const net = await fiveBlocks()
  const r = net.nodes[1].store.blocks().find(b => b.rulings[0].asc === 'factcheck-ceo-revenue-doubled').rulings[0]
  assert.equal(r.dissent.length, 1)
  const pay = Object.fromEntries(r.diff.map(d => [d.account, d.delta]))
  const each = r.votes.map(v => pay[`harness:${v.harness}`])
  assert.ok(each.every(x => x > 0 && x === each[0]))
  assert.equal(pay[`harness:${r.dissent[0].harness}`], each[0])
})

test('rulings are append-only in the store', async () => {
  const net = await fiveBlocks()
  const db = net.nodes[0].store.db
  assert.throws(() => db.exec("UPDATE blocks SET sealer = 'x'"), /append-only/)
  assert.throws(() => db.exec('DELETE FROM rulings'), /append-only/)
  assert.equal(net.nodes[0].store.blocks().length, 5)
})

test('a block arriving twice is a no-op; a different block at a held height is a fork and is refused', async () => {
  const net = await fiveBlocks()
  const b = net.nodes[0].store.block(3)
  await net.nodes[1].handleGossip('block', b)
  await assert.rejects(net.nodes[1].handleGossip('block', { ...b, hash: sha256('x') }), err => err.code === 'fork')
})

test('gossip: a reveal that does not match the gossiped commitment is refused', async () => {
  const net = await network()
  await net.nodes[0].submit(example('market-resolution'))
  const block = await net.sealer().prepareBlock()
  const env = block.rulings[0]
  const r = structuredClone(env.round.reveals[0])
  r.vote.answer = 'YES'
  await assert.rejects(net.nodes[2].handleGossip('reveal', { ascHash: env.ascHash, reveal: r }), /does not match its commitment/)
  const other = structuredClone(env.round.commits[0])
  other.commitment = sha256('another vote')
  await assert.rejects(net.nodes[2].handleGossip('commit', { ascHash: env.ascHash, commit: other }), /does not verify|equivocated/)
})

test('gossip: a contract travels without its context bytes, and peers fetch them by hash', async () => {
  const net = await network()
  const asc = example('delay-cover')
  const h = await net.nodes[0].submit(asc)
  for (const n of net.nodes) {
    const entry = n.store.contract(h)
    assert.ok(entry.asc.context.every(c => c.content === undefined))
    for (const c of asc.context) assert.equal(n.storage.get(c.sha256), c.content)
  }
})

// Challenges: a later jury reviews a sealed ruling. A challenge is core's
// `challengeContract`; its ruling appends core's `resolveChallenge` review. The
// original never changes.
const CHALLENGE_POOL = { harnesses: [...FIVE_LABS, ...SECOND_FIVE.map(h => h.id)], extra: SECOND_FIVE }
const market = example('market-resolution')
const answers = vote => Object.fromEntries(Object.keys(SCRIPT[market.id]).map(lab => [lab, { answer: vote, confidence: 0.9, reasoning: `Scripted ${vote}.` }]))
const evidence = text => [{ kind: 'text', label: 'new evidence', content: text }]

async function sealedMarket(script) {
  const net = await network({ ...CHALLENGE_POOL, script: { ...SCRIPT, ...script } })
  await net.nodes[0].submit(market)
  const first = await net.step()
  return { net, original: first.rulings[0], id: rulingId(first.rulings[0]) }
}

test('a challenge block that overturns: the review rides under the reviews root, every node appends it, the original is unchanged', async () => {
  const { net, original, id } = await sealedMarket({ 'challenge-overturn': answers('YES') })
  assert.equal(original.answer, 'NO')
  const before = canonical(net.nodes[0].store.ruling(id))
  const asc = challengeContract(market, original, { grounds: 'false-evidence', evidence: evidence('The roll call was forged.'), excludeLabs: [], id: 'challenge-overturn' })
  assert.equal(asc.review.kind, 'swarm.challenge/0')
  await net.nodes[1].submit(asc)
  const block = await net.step()
  assert.ok(block, 'challenge sealed')
  const ruling = block.rulings[0]
  assert.equal(ruling.answer, 'YES')
  assert.ok(ruling.round.jury.every(c => !original.round.jury.some(o => o.id === c.id)), 'no original juror sits on the challenge jury')
  assert.equal(block.reviews.length, 1)
  assert.deepEqual(block.reviews[0], resolveChallenge(asc, ruling, original))
  assert.equal(block.reviews[0].result, 'overturn')
  assert.equal(block.reviewsRoot, sha256(block.reviews.map(r => sha256(r)).join('')))
  for (const n of net.nodes) {
    assert.equal(n.tip().hash, block.hash)
    assert.deepEqual(n.store.reviews(id).map(r => [r.result, r.by]), [['overturn', rulingId(ruling)]])
    assert.equal(canonical(n.store.ruling(id)), before, 'original ruling unchanged')
    const got = readApi(n.store)({ method: 'GET', path: ['rulings', id], query: new URLSearchParams() }).body
    assert.equal(got.review.status, 'overturned')
  }
})

test('challenges append affirm, overturn and supersede; below the bar the original stands; the original ruling is never edited', async () => {
  const split = { ...answers('YES'), anthropic: { answer: 'NO', confidence: 0.9, reasoning: 'No.' }, openai: { answer: 'UNCLEAR', confidence: 0.9, reasoning: 'Unclear.' } }
  const { net, original, id } = await sealedMarket({ 'challenge-affirm': answers('NO'), 'challenge-overturn': answers('YES'), 'challenge-supersede': answers('YES'), 'challenge-split': split })
  const before = canonical(net.nodes[0].store.ruling(id))
  const cases = [
    ['challenge-affirm', 'new-evidence', { evidence: evidence('A second count agrees.') }],
    ['challenge-overturn', 'false-evidence', { evidence: evidence('The roll call was forged.') }],
    ['challenge-split', 'error', {}],
    ['challenge-supersede', 'changed-rules', { context: [...market.context, { kind: 'policy', content: 'Rules as amended.' }].map(c => ({ ...c, sha256: c.sha256 ?? sha256(c.content) })) }],
  ]
  for (const [cid, grounds, extra] of cases) {
    await net.nodes[1].submit(challengeContract(market, original, { grounds, excludeLabs: [], id: cid, ...extra }))
    assert.ok(await net.step(), `${cid} sealed`)
  }
  for (const n of net.nodes) {
    assert.deepEqual(n.store.reviews(id).map(r => [r.result, r.grounds]), [['affirm', 'new-evidence'], ['overturn', 'false-evidence'], ['supersede', 'changed-rules']])
    assert.equal(canonical(n.store.ruling(id)), before, 'original ruling unchanged')
    assert.throws(() => n.store.db.exec("UPDATE reviews SET result = 'affirm'"), /append-only/)
    assert.throws(() => n.store.db.exec('DELETE FROM reviews'), /append-only/)
    const got = readApi(n.store)({ method: 'GET', path: ['rulings', id], query: new URLSearchParams() }).body
    assert.equal(got.review.status, 'superseded')
    assert.equal(got.review.reviewCount, 3)
    assert.equal(got.reviews.length, 3)
  }
})

test('a challenge block that misstates or drops its review is rejected', async () => {
  const { net, original } = await sealedMarket({ 'challenge-x': answers('YES') })
  await net.nodes[0].submit(challengeContract(market, original, { grounds: 'false-evidence', evidence: evidence('Forged roll call found.'), excludeLabs: [], id: 'challenge-x' }))
  const sealer = net.sealer()
  const block = await sealer.prepareBlock()
  const reviews = structuredClone(block.reviews)
  assert.equal(reviews[0].result, 'overturn')
  reviews[0].result = 'affirm'
  for (const n of net.nodes) await assert.rejects(n.accept(reseal(sealer, block.rulings, reviews)), err => err.code === 'review')
  for (const n of net.nodes) await assert.rejects(n.accept(reseal(sealer, block.rulings, [])), err => err.code === 'review')
  const unrooted = { ...block, reviews: [...block.reviews, block.reviews[0]] }
  for (const n of net.nodes) await assert.rejects(n.accept(unrooted), err => err.code === 'review')
})

test('a challenge must name a ruling that is on chain, state declared grounds, and keep the original jurors off its jury', async () => {
  const net = await network(CHALLENGE_POOL)
  const fc = example('fact-check')
  const review = { kind: 'swarm.challenge/0', ruling: sha256('nothing'), ascHash: sha256('no contract'), grounds: 'error' }
  await assert.rejects(net.nodes[0].submit({ ...fc, review }), /not on chain/)
  await assert.rejects(net.nodes[0].submit({ ...fc, review: { ...review, grounds: 'vibes' } }), /grounds/)
  const { net: chain, original } = await sealedMarket({ 'challenge-reuse': answers('YES') })
  const asc = challengeContract(market, original, { grounds: 'error', excludeLabs: [], id: 'challenge-reuse' })
  const reused = { ...asc, payment: { ...asc.payment, jury: { ...asc.payment.jury, excludeHarnesses: [] } } }
  await assert.rejects(chain.nodes[0].submit(reused), /exclude the original jurors/)
})

test('storage: serves context by hash through the window, refuses wrong bytes, prunes after', () => {
  let now = 1_000
  const store = new ContextStore(new BlockStore().db, { windowMs: 100, now: () => now })
  const h = store.put('pinned snapshot')
  assert.equal(h, sha256('pinned snapshot'))
  assert.throws(() => store.put('other bytes', h), /does not match pin/)
  assert.deepEqual(store.route({ method: 'GET', path: ['storage', h] }).body, { sha256: h, content: 'pinned snapshot' })
  store.retain(h, 1_050)
  now = 1_120
  assert.equal(store.prune(), 0, 'retained through the ruling\'s window')
  now = 1_200
  assert.equal(store.prune(), 1)
  assert.equal(store.route({ method: 'GET', path: ['storage', h] }).status, 404)
})

test('read API: blocks, rulings, contracts, harness records', async () => {
  const net = await fiveBlocks()
  const api = readApi(net.nodes[0].store)
  const q = new URLSearchParams()
  const get = (...path) => api({ method: 'GET', path, query: q })
  assert.equal(get('blocks').body.length, 5)
  assert.equal(get('blocks', '2').body.hash, get('blocks', get('blocks', '2').body.hash).body.hash)
  assert.equal(get('rulings').body.length, 5)
  assert.equal(get('contracts').body.length, 5)
  const records = get('harnesses').body
  assert.equal(records.length, 5)
  for (const h of records) { assert.equal(h.seated, 5); assert.equal(h.counted, 5); assert.ok(h.earned > 0) }
  assert.equal(get('blocks', '99').status, 404)
})
