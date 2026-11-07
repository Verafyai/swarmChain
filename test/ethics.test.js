// MASTER_SPEC Part G1: the ethics gate (draft Constitution, Article 3) on an
// in-process devnet (three nodes, scripted answers, no model calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { ascHash, sealContract } from '#core'
import { network, example, reseal, clone, SCRIPT, FIVE_LABS, SECOND_FIVE } from './helpers.js'
import { ChainNode, localJurorClient, startNode } from '../packages/node/src/index.js'
import { loadChainConfig } from '../packages/node/src/batch.js'
import { embeddedEthics, ethicsParams, NEVER_ALLOWED_REFS } from '../packages/node/src/ethics.js'

const NEVER = JSON.parse(readFileSync(new URL('./fixtures/never-allowed-market.json', import.meta.url), 'utf8'))
const TEN = [...FIVE_LABS, ...SECOND_FIVE.map(h => h.id)]
const vote = (answer, sources = ['c0', 'c1'], confidence = 0.9) => ({ answer, confidence, reasoning: `Scripted answer: ${answer}.`, sources })

/** An example contract under a new id, with its jury answers copied. */
function renamed(name, id) {
  const asc = { ...example(name), id }
  return { asc, answers: { [id]: SCRIPT[example(name).id] } }
}

test('the Embedded Ethics are quoted from CONSTITUTION.md as written, nine Never allowed items, each pinned on its own', () => {
  const e = embeddedEthics()
  assert.equal(e.neverAllowed.length, 9)
  assert.match(e.neverAllowed[1], /^2\. \*\*Violence\.\*\* Markets or contracts on a person's death or injury/)
  assert.match(e.neverAllowed[8], /^9\. \*\*What Article 1 forbids\.\*\*/)
  assert.match(e.article3, /5\. \*\*No bypass\.\*\* Nobody, including whoever wrote the code, can switch the gate off/)
  assert.ok(!e.article3.includes('Status:'), 'the status note is not part of the pinned text')
  const constitution = readFileSync(new URL('../CONSTITUTION.md', import.meta.url), 'utf8')
  for (const item of e.neverAllowed) assert.ok(constitution.includes(item))
  assert.deepEqual(NEVER_ALLOWED_REFS, ['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'])
})

test('an Allowed contract is screened allow by a panel from several labs, then ruled, in the same block', async () => {
  const net = await network()
  await net.nodes[0].submit(example('market-resolution'))
  const block = await net.step()
  assert.equal(block.rulings.length, 1)
  const [s] = block.screenings
  assert.equal(s.outcome, 'allow')
  assert.equal(s.panels.length, 1)
  const panel = s.panels[0]
  assert.equal(panel.asc, 'ethics/market-senate-bill-nov30')
  assert.equal(panel.round.jury.length, 3)
  assert.equal(new Set(panel.round.jury.map(c => c.lab)).size, 3)
  assert.equal(panel.round.seed, block.parent, 'drawn from the parent block hash')
  assert.equal(panel.round.commits.length, 3, 'commit and reveal, like any jury')
  assert.ok(block.screeningsRoot)
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)
})

test('a Never allowed contract is refused: it never reaches a jury, its whole escrow returns, and the ruling and reasons are recorded', async () => {
  const net = await network()
  const calls = []
  for (const n of net.nodes) { const inner = n.jurors; n.jurors = { ...inner, commit: (e, asc) => { calls.push(asc.id); return inner.commit(e, asc) } } }
  const h = await net.nodes[0].submit(NEVER)
  const block = await net.step()
  assert.equal(block.rulings.length, 0, 'no jury ruled')
  const [s] = block.screenings
  assert.equal(s.outcome, 'refuse')
  assert.deepEqual(s.neverAllowed, [2])
  assert.match(s.why, /Never allowed 2/)
  assert.equal(s.reasons.length, 3)
  for (const r of s.reasons) assert.match(r.reasoning, /person's injury/)
  assert.deepEqual(s.refund, [{ account: 'escrow:market-goalkeeper-injury', delta: -2 }, { account: 'sender:market-goalkeeper-injury', delta: 2 }])
  assert.ok(calls.every(id => id === 'ethics/market-goalkeeper-injury'), `only the screening panel read it (${calls.join(', ')})`)
  for (const n of net.nodes) {
    assert.equal(n.tip().hash, block.hash)
    assert.equal(n.store.contract(h).status, 'refused')
  }
  // The refused contract never comes back.
  assert.equal(await net.step(), null)
})

test('a close call escalates to a wider panel that shares no harness with the first; the wider panel decides', async () => {
  const { asc, answers } = renamed('fact-check', 'factcheck-close-call')
  const net = await network({ harnesses: TEN, extra: SECOND_FIVE, panels: { ...answers, 'ethics/factcheck-close-call': { '*': vote('escalate', ['c0', 'c11']) }, 'ethics/factcheck-close-call/wider': { '*': vote('allow') } } })
  await net.nodes[0].submit(asc)
  const block = await net.step()
  const [s] = block.screenings
  assert.equal(s.panels.length, 2)
  assert.equal(s.panels[0].exit, 'escalate')
  assert.equal(s.panels[1].round.jury.length, 5)
  const first = new Set(s.panels[0].round.jury.map(c => c.id))
  assert.ok(s.panels[1].round.jury.every(c => !first.has(c.id)))
  assert.equal(s.outcome, 'allow')
  assert.equal(block.rulings.length, 1)
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)
})

test('doubt resolves toward refusal: a wider panel below the bar refuses, and so does a wider panel that cannot be seated', async () => {
  const { asc, answers } = renamed('fact-check', 'factcheck-doubt')
  const split = { anthropic: vote('allow'), openai: vote('refuse'), google: vote('allow'), meta: vote('refuse'), qwen: vote('escalate') }
  const net = await network({ harnesses: TEN, extra: SECOND_FIVE, panels: { ...answers, 'ethics/factcheck-doubt': { '*': vote('escalate') }, 'ethics/factcheck-doubt/wider': split } })
  await net.nodes[0].submit(asc)
  const block = await net.step()
  const [s] = block.screenings
  assert.equal(s.panels[1].passed, false)
  assert.equal(s.outcome, 'refuse')
  assert.match(s.why, /doubt resolves toward refusal/)
  assert.equal(block.rulings.length, 0)
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)

  // Five harnesses: a first panel of three leaves two, too few for a wider panel of five.
  const small = await network({ panels: { ...answers, 'ethics/factcheck-doubt': { '*': vote('escalate') } } })
  await small.nodes[0].submit(asc)
  const b2 = await small.step()
  assert.equal(b2.screenings[0].outcome, 'refuse')
  assert.match(b2.screenings[0].why, /no wider panel could be seated/)
})

test('a Never allowed item is a hard refusal: the first panel cannot allow over a refuse vote that cites one', async () => {
  const { asc, answers } = renamed('market-resolution', 'market-hard-flag')
  const first = { '*': vote('allow'), anthropic: vote('refuse', ['c0', 'c7'], 0.2), openai: vote('refuse', ['c0', 'c7'], 0.2) }
  const net = await network({ harnesses: TEN, extra: SECOND_FIVE, panels: { ...answers, 'ethics/market-hard-flag': first, 'ethics/market-hard-flag/wider': { '*': vote('refuse', ['c0', 'c7']) } } })
  await net.nodes[0].submit(asc)
  const block = await net.step()
  const [s] = block.screenings
  assert.ok(s.panels[0].votes.some(v => v.answer === 'refuse'), 'a scripted refuse vote sits on the first panel')
  assert.equal(s.panels[0].passed, true)
  assert.equal(s.panels[0].exit, 'allow')
  assert.equal(s.panels.length, 2, 'allow with a hard refusal on record goes to the wider panel')
  assert.equal(s.outcome, 'refuse')
  assert.deepEqual(s.neverAllowed, [6])
})

test('a harness may decline a screening seat on ethics grounds: no fault, no pay, never a bond', async () => {
  const net = await network()
  const reason = 'I will not sit on a market about a person being hurt.'
  for (const { harness } of net.harnesses.values()) harness.declines = a => a.id.startsWith('ethics/market-goalkeeper-injury') ? reason : null
  await net.nodes[0].submit(NEVER)
  const block = await net.step()
  const panel = block.screenings[0].panels[0]
  assert.equal(panel.round.declines.length, 3)
  for (const d of panel.round.declines) assert.equal(d.reason, reason)
  assert.deepEqual(panel.round.faults, [], 'declining is never a fault')
  assert.ok(!panel.diff.some(d => d.account.startsWith('harness:') && d.delta > 0), 'a declined seat is not paid')
  // Nobody sat, so nobody cleared the bar: doubt resolves toward refusal (the five-harness pool cannot seat a wider panel).
  assert.equal(block.screenings[0].outcome, 'refuse')
  for (const n of net.nodes) { assert.equal(n.tip().hash, block.hash); assert.deepEqual(n.store.faults(), []) }
})

test('no bypass: no config key, environment variable, contract field, option or API parameter skips the gate', async () => {
  // Config: switches that do not exist change nothing; values below the floors are refused at start.
  const base = loadChainConfig()
  const withKeys = structuredClone(base)
  Object.assign(withKeys.ethics, { enabled: { value: false }, bypass: { value: true }, skip: { value: true }, exempt: { value: ['market-goalkeeper-injury'] }, mode: { value: 'off' } })
  withKeys.ethicsGate = false
  withKeys.bypassEthics = true
  for (const [patch, re] of [
    [c => { delete c.ethics }, /no ethics section/],
    [c => { c.ethics.panel.size.value = 0 }, /panel.size must be at least 3/],
    [c => { c.ethics.panel.minLabs.value = 1 }, /minLabs must be at least 2/],
    [c => { c.ethics.bar.value = 0 }, /bar must be above 0.5/],
    [c => { c.ethics.fee.value = 0 }, /fee must be positive/],
    [c => { c.ethics.wider.size.value = 3 }, /wider.size must be larger/],
  ]) {
    const c = structuredClone(base)
    patch(c)
    assert.throws(() => ethicsParams(c), re)
    assert.throws(() => new ChainNode({ id: 'node-x', jurors: localJurorClient(new Map()), config: c }), re)
  }
  // Environment variables someone might try.
  const ENV = ['VERAFY_ETHICS_BYPASS', 'VERAFY_SKIP_ETHICS', 'SKIP_ETHICS', 'ETHICS_GATE', 'VERAFY_ETHICS_GATE', 'VERAFY_GATE', 'NO_ETHICS', 'SWARM_ETHICS_BYPASS', 'VERAFY_DEV', 'NODE_ENV']
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  for (const k of ENV) process.env[k] = k === 'NODE_ENV' ? 'development' : k === 'ETHICS_GATE' || k.endsWith('_GATE') ? 'off' : '1'
  try {
    const net = await network({ config: withKeys })
    // Contract fields and submit options that look like an exemption.
    const dressed = { ...NEVER, ethics: 'exempt', exempt: true, bypass: true, gate: { exempt: true, level: 0 }, payment: { ...NEVER.payment, ethicsExempt: true } }
    const h = await net.nodes[0].submit(dressed, { bypass: true, skipEthics: true, exempt: true, gate: false })
    const block = await net.step()
    assert.equal(block.rulings.length, 0)
    assert.equal(block.screenings[0].outcome, 'refuse')
    assert.equal(net.nodes[0].store.contract(h).status, 'refused')
  } finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
  // The source reads no environment variable at all.
  const dir = new URL('../packages/node/src/', import.meta.url)
  for (const f of readdirSync(dir)) assert.ok(!readFileSync(new URL(f, dir), 'utf8').includes('process.env'), `${f} reads no environment variable`)

  // API parameters: body fields and query strings on a real HTTP node.
  const node = await startNode({ id: 'node-1', port: 7590, peers: ['http://127.0.0.1:7590'] })
  try {
    const res = await fetch('http://127.0.0.1:7590/contracts?bypass=1&ethics=off&skipGate=true', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ethics-bypass': '1' }, body: JSON.stringify({ asc: NEVER, bypass: true, skipEthics: true, exempt: true }) })
    assert.equal(res.status, 201)
    assert.equal(node.node.store.contract(ascHash(NEVER)).status, 'pending', 'queued for screening like any contract; nothing marked it exempt')
  } finally { await node.close() }
})

test('every node rejects a block that rules a contract without its allow screening, or forges one', async () => {
  const net = await network()
  await net.nodes[0].submit(example('market-resolution'))
  const sealer = net.sealer()
  const honest = await sealer.prepareBlock()
  // Dropped: the ruling alone.
  for (const n of net.nodes) await assert.rejects(n.accept(reseal(sealer, honest.rulings)), err => err.code === 'ethics-gate')
  // Forged: the screening says allow but the panel's ruling is edited.
  const forged = clone(honest.screenings)
  forged[0].panels[0].agreement = 0.5
  const { seal } = await import('#core')
  const b = seal(sealer.tip(), honest.rulings, sealer.signer, { time: honest.time, screenings: forged })
  for (const n of net.nodes) await assert.rejects(n.accept(b), err => err.code === 'replay' || err.code === 'ethics-gate')
  // A refusal flipped to allow.
  const s = await network()
  await s.nodes[0].submit(NEVER)
  const real = await s.sealer().prepareBlock()
  assert.equal(real.screenings[0].outcome, 'refuse')
  const flip = clone(real.screenings)
  flip[0].outcome = 'allow'
  delete flip[0].refund
  const b2 = seal(s.sealer().tip(), [], s.sealer().signer, { time: real.time, screenings: flip })
  for (const n of s.nodes) await assert.rejects(n.accept(b2), err => err.code === 'ethics-gate')
})

test('the encrypted queue: the screening panel is drawn with the jury before shares are released, and a queued Never allowed contract is refused', async () => {
  const clock = { now: Date.now() }
  const net = await network({ clock })
  const committee = net.nodes[0].committee()
  const asc = { ...NEVER, payment: { ...NEVER.payment, maxWaitSeconds: 1, jury: { ...NEVER.payment.jury, assurance: 'L2' } } }
  const env = sealContract(asc, committee.nodes, { t: committee.t, escrowRef: 'solana:devnet/escrow-never' })
  await net.nodes[1].submitSealed(env)
  clock.now += 120_000
  const block = await net.step()
  assert.equal(block.rulings.length, 0)
  assert.equal(block.screenings[0].outcome, 'refuse')
  assert.equal(block.screenings[0].subject, ascHash(asc))
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)
})
