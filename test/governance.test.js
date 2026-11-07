// MASTER_SPEC Part G2: the amendment process (draft Constitution Article 5,
// AMENDMENTS.md) on an in-process devnet: three nodes, 42 harnesses across six
// labs, the draft panel sizes (7, 7, 15) and windows (14 days) from
// config/chain.json, a test clock, and scripted answers (no model calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { seal, sha256, AMENDMENT_STAGES } from '#core'
import { network, example, clone } from './helpers.js'
import { consolidate } from '../packages/node/src/governance.js'

const DAY = 24 * 3600 * 1000
const LABS = ['anthropic', 'openai', 'google', 'meta', 'qwen', 'deepseek']
const POOL = LABS.flatMap(lab => Array.from({ length: 7 }, (_, i) => ({ id: `g-${lab}-${i + 1}`, lab, model: `${lab}-scripted-model`, bond: 500 })))
const PROPOSER = 'g-anthropic-1'
const COMMENTER = 'g-openai-1'

const pinOf = text => `sha256:${sha256(text)}`
/** A-1: the AMENDMENTS.md example, adding a Never allowed item (an Extend of an entrenched list, which makes it stricter). */
const ADD = {
  kind: 'verafy.amendment/1', id: 'A-1', amendmentKind: 'extend', target: 'ethics.neverAllowed', cites: ['block:0', 'constitution.article.3'],
  text: '10. **Election betting by jurors.** Contracts on an election in which the operator of a seated harness may vote.',
  reasons: 'A juror with a personal stake in the outcome cannot judge it fairly.',
  context: [{ role: 'comment-window', pin: pinOf('A-1 comment window') }],
  payment: { asset: 'USDC', chain: 'solana', escrow: 5 }, exits: ['adopt', 'reject', 'revise'], proposer: { harnesses: [PROPOSER] },
}
/** A-2: remove "No treasury" (Article 1, clause 7). Entrenched: it can never pass. */
const REMOVE = {
  ...ADD, id: 'A-2', amendmentKind: 'reclassify', target: 'constitution.article.1.7', cites: ['block:0', 'constitution.article.1'],
  text: 'Remove clause 7 (No treasury) from Article 1, so the chain may hold funds of its own.',
  reasons: 'Scripted test fixture: an amendment that tries to weaken an entrenched clause.',
  context: [{ role: 'comment-window', pin: pinOf('A-2 comment window') }],
}

async function setup() {
  const clock = { now: Date.parse('2026-11-06T12:00:00Z') }
  const net = await network({ harnesses: POOL.map(h => h.id), extra: POOL, clock })
  return { net, clock, advance: ms => { clock.now += ms } }
}
const records = block => (block?.governance ?? []).map(r => `${r.amendment} ${r.stage} ${r.result}`)
const jurorsOf = r => (r.panels ?? []).flatMap(p => p.round.jury.map(c => c.id))

test('an amendment that adds a Never allowed item runs all seven stages and seals; one that removes "No treasury" stops at the constitution check', async () => {
  const { net, advance } = await setup()
  const [n1, n2] = net.nodes
  await n1.proposeAmendment(ADD)
  await n2.proposeAmendment(REMOVE)
  await assert.rejects(n1.proposeAmendment({ ...ADD, id: 'A-9' }), /assigned in order of posting; the next is A-3/)

  // 1. Propose: the ethics gate screens each proposal, with the proposer's harness kept off the panel.
  const b1 = await net.step()
  assert.deepEqual(records(b1), ['A-1 propose allow', 'A-2 propose allow'])
  for (const s of b1.screenings) { assert.equal(s.subjectKind, 'amendment'); assert.ok(!jurorsOf(s).includes(PROPOSER)) }

  // 2. Comment: a signed comment from a harness; that harness is kept off every later panel.
  const h = net.harnesses.get(COMMENTER).harness
  const body = { kind: 'verafy.comment/1', amendment: 'A-1', text: 'Support: an operator who can vote has a stake.', harness: COMMENTER }
  await n2.addComment({ ...body, signature: h.sign(body) })
  await assert.rejects(n2.addComment({ ...body, text: 'forged', signature: h.sign(body) }), /signature does not verify/)
  assert.equal(await net.step(), null, 'the 14-day comment window (proposed) is still open: no block')
  advance(14 * DAY)

  // 3. Constitution check, in the block that closes the comment window.
  const b2 = await net.step()
  assert.deepEqual(records(b2), ['A-1 comment closed', 'A-1 constitution-check passes', 'A-2 comment closed', 'A-2 constitution-check conflicts'])
  const [, check1, , check2] = b2.governance
  assert.equal(check1.panels[0].round.jury.length, 7)
  assert.ok(new Set(check1.panels[0].round.jury.map(c => c.lab)).size >= 4)
  assert.equal(check1.cites, sha256(b2.governance[0]), 'each stage cites the one before')
  assert.ok(check2.reasons.some(r => /entrenched: reclassify cannot touch an entrenched clause \(Article 1\)/.test(r)))
  assert.equal(check2.panels[0].exit, 'conflicts')
  assert.deepEqual(check2.escrow, { used: 0.75, returned: 4.25 }, 'what no panel used returns to the proposer (stage shares illustrative)')

  // 4 and 5. Ethics check, then merit, one stage per block; A-2 never moves again.
  const b3 = await net.step()
  assert.deepEqual(records(b3), ['A-1 ethics-check passes'])
  const b4 = await net.step()
  assert.deepEqual(records(b4), ['A-1 merit adopt'])
  assert.equal(b4.governance[0].panels[0].round.jury.length, 15)
  assert.equal(b4.governance[0].panels[0].bar, 0.75)

  // 6 and 7. The challenge window (14 days, proposed) closes unchallenged, and the seal rides the next block a jury rules.
  assert.equal(await net.step(), null)
  advance(14 * DAY + 1000)
  assert.equal(await net.step(), null, 'closing a window is not a ruling: no block without a jury')
  await n1.submit(example('market-resolution'))
  const b5 = await net.step()
  assert.deepEqual(records(b5), ['A-1 challenge unchallenged', 'A-1 seal sealed'])
  assert.equal(b5.rulings.length, 1)
  const sealRec = b5.governance[1]
  const hist = [b1, b2, b3, b4, b5].flatMap(b => b.governance).filter(r => r.amendment === 'A-1')
  assert.deepEqual(hist.map(r => r.stage), AMENDMENT_STAGES)
  assert.deepEqual(sealRec.cited, ['block:0', 'ethics.neverAllowed', ...hist.slice(0, 6).map(r => sha256(r))])
  assert.equal(sealRec.effective, b5.height + 1, 'effective from the next block, never retroactively')
  assert.deepEqual(sealRec.escrow, { used: 3.25, returned: 1.75 })

  // Panels: no proposer or commenter harness, and no harness on two stages.
  const sat = [...b1.screenings.filter(s => s.id === 'A-1').flatMap(jurorsOf), ...hist.flatMap(jurorsOf)]
  assert.equal(sat.length, 3 + 7 + 7 + 15)
  assert.equal(new Set(sat).size, sat.length)
  assert.ok(!sat.includes(PROPOSER) && !sat.includes(COMMENTER))

  // Every node holds the same chain, and the same consolidated text: Block 0 plus A-1, marked.
  for (const n of net.nodes) assert.equal(n.tip().hash, b5.hash)
  const text = n1.constitution()
  assert.ok(text.includes(`${ADD.text} *(Amendment A-1, sealed in block ${b5.height})*`))
  assert.ok(text.indexOf('10. **Election betting') > text.indexOf('9. **What Article 1 forbids'))
  assert.ok(text.includes('7. **No treasury.**'), 'A-2 never sealed; "No treasury" stands')
  assert.equal(text, n2.constitution())
  assert.equal(consolidate(undefined, []), readFileSync(new URL('../CONSTITUTION.md', import.meta.url), 'utf8'), 'with nothing sealed, the text is Block 0 exactly')
  assert.ok(!/block 0 hash/i.test(text), 'Draft 0: no Block 0 hash anywhere')
})

test('verify.js refuses a seal missing a stage, a reused harness, a proposer or commenter on a panel, and anything weakening an entrenched clause', async () => {
  const { net, advance } = await setup()
  const [n1] = net.nodes
  await n1.proposeAmendment(ADD)
  await n1.proposeAmendment(REMOVE)
  await net.step()
  const h = net.harnesses.get(COMMENTER).harness
  const body = { kind: 'verafy.comment/1', amendment: 'A-1', text: 'Support.', harness: COMMENTER }
  await n1.addComment({ ...body, signature: h.sign(body) })
  const reseal = (s, block, governance) => seal(s.tip(), block.rulings, s.signer, { time: block.time, screenings: block.screenings, governance })
  const rejects = async (block, code) => { for (const n of net.nodes) await assert.rejects(n.accept(block), err => err.code === code, code) }

  // Too early: the comment window has not run.
  let s = net.sealer()
  await n1.submit(example('market-resolution'))
  const early = await s.prepareBlock()
  const p1 = net.nodes[0].amendments.get('A-1')
  const hist = [...(await import('../packages/node/src/governance.js')).governanceHistory(s.store.blocks()).get('A-1')]
  const fakeComment = { kind: 'verafy.stage/1', amendment: 'A-1', amendmentHash: p1.hash, stage: 'comment', cites: hist[0].id, result: 'closed', opened: hist[0].time, closed: early.time, comments: [] }
  await rejects(reseal(s, early, [fakeComment]), 'amendment-window')
  await s.accept(early)
  for (const n of net.others(s)) await n.accept(early)

  advance(14 * DAY)
  s = net.sealer()
  const b2 = await s.prepareBlock()
  const [comment, check, , conflict] = b2.governance
  // Entrenched: the No treasury amendment cannot be recorded as passing the constitution check.
  await rejects(reseal(s, b2, [comment, check, b2.governance[2], { ...conflict, result: 'passes' }]), 'amendment-entrenched')
  // The proposer's harness, or the commenter's, on a panel.
  const withProposer = clone(check)
  withProposer.panels[0].round.jury[0].id = PROPOSER
  await rejects(reseal(s, b2, [comment, withProposer]), 'amendment-excluded')
  const withCommenter = clone(check)
  withCommenter.panels[0].round.jury[1].id = COMMENTER
  await rejects(reseal(s, b2, [comment, withCommenter]), 'amendment-excluded')
  // A stage skipped: the comment record dropped.
  await rejects(reseal(s, b2, [check]), 'amendment-stage')
  await s.accept(b2)
  for (const n of net.others(s)) await n.accept(b2)

  s = net.sealer()
  const b3 = await s.prepareBlock()
  const [ethics] = b3.governance
  // A harness reused: a constitution check juror on the ethics check panel.
  const reused = clone(ethics)
  reused.panels[0].round.jury[0].id = check.panels[0].round.jury[0].id
  await rejects(reseal(s, b3, [reused]), 'amendment-reuse')
  // Anything after a stop: an ethics check for the amendment that conflicted.
  const after = { ...clone(ethics), amendment: 'A-2', amendmentHash: sha256(REMOVE), cites: sha256(conflict) }
  await rejects(reseal(s, b3, [after]), 'amendment-entrenched')
  // A seal missing stages: sealing A-1 straight after its constitution check.
  const early7 = { kind: 'verafy.stage/1', amendment: 'A-1', amendmentHash: p1.hash, stage: 'seal', cites: sha256(check), result: 'sealed', cited: ['block:0', 'ethics.neverAllowed'], effective: b3.height + 1, escrow: { used: 0.75, returned: 4.25 } }
  await rejects(reseal(s, b3, [ethics, early7]), 'amendment-stage')
  // An edited result: the ethics check panel's ruling says passes; the record cannot say breaches.
  await rejects(reseal(s, b3, [{ ...ethics, result: 'breaches', escrow: { used: 1.5, returned: 3.5 } }]), 'amendment-result')
  await s.accept(b3)
  for (const n of net.others(s)) await n.accept(b3)
})

test('the read and write routes: post an amendment, read its state, and read the consolidated text (Draft 0, no Block 0 hash)', async () => {
  const { startNode } = await import('../packages/node/src/index.js')
  const node = await startNode({ id: 'node-1', port: 7591, peers: ['http://127.0.0.1:7591'] })
  try {
    const post = await fetch('http://127.0.0.1:7591/amendments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amendment: ADD }) })
    assert.equal(post.status, 201)
    assert.equal((await post.json()).amendmentHash, sha256(ADD))
    const bad = await fetch('http://127.0.0.1:7591/amendments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amendment: { ...ADD, id: 'A-2', target: ['ethics.neverAllowed', 'constitution.article.1'] } }) })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /exactly one article, list or earlier amendment/)
    const list = await (await fetch('http://127.0.0.1:7591/amendments')).json()
    assert.deepEqual(list.map(a => [a.id, a.state]), [['A-1', 'awaiting screening']])
    const c = await (await fetch('http://127.0.0.1:7591/constitution')).json()
    assert.match(c.status, /^Draft 0/)
    assert.ok(c.text.startsWith('# The Verafy Chain Constitution'))
    assert.ok(!/block 0 hash/i.test(JSON.stringify(c)))
  } finally { await node.close() }
})
