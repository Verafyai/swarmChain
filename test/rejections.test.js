// A node rejects every block that breaks a design rule. Each test builds an
// honest block with a real jury round, tampers with one thing as a dishonest
// sealer would, re-seals it with the sealer's own key, and checks every other
// node refuses it with the expected code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256, signMessage, seal, drawJury, conserves } from '#core'
import { GENESIS, BlockRejected } from '../packages/node/src/index.js'
import { Harness } from '#core'
import { network, example, reseal, clone, CONFIG } from './helpers.js'

async function honest(name, options) {
  const net = await network(options)
  await net.nodes[0].submit(example(name))
  const sealer = net.sealer()
  const block = await sealer.prepareBlock()
  return { net, sealer, block, env: clone(block.rulings[0]) }
}

async function rejectsEverywhere(net, sealer, block, code) {
  for (const n of net.nodes) {
    await assert.rejects(n.accept(block), err => err instanceof BlockRejected && err.code === code, `${n.id} should reject with ${code}`)
    assert.equal(n.tip(), null, `${n.id} appended nothing`)
  }
}

test('an honest block is accepted by every node', async () => {
  const { net, block } = await honest('market-resolution')
  for (const n of net.nodes) await n.accept(block)
  assert.deepEqual(net.nodes.map(n => n.tip().hash), Array(3).fill(block.hash))
})

test('no empty blocks: core refuses to seal one, a node refuses to accept one, and no contract means no block', async () => {
  const net = await network()
  const sealer = net.sealer()
  assert.throws(() => seal(null, [], sealer.signer), /no rulings, no block/)
  const header = { height: 1, parent: GENESIS, rulingsRoot: sha256(''), sealer: sealer.id, time: new Date().toISOString() }
  const empty = { ...header, hash: sha256(header), signature: signMessage(sealer.identity.privateKey, header), rulings: [] }
  await rejectsEverywhere(net, sealer, empty, 'empty')
  assert.equal(await sealer.sealNext(), null)
  assert.equal(sealer.tip(), null)
})

test('rejects a diff that does not conserve', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.diff[0].delta += 0.1
  assert.equal(conserves(env.diff), false)
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'diff-conserve')
})

test('rejects a reveal that does not match its commitment, even with a valid signature', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  const r = env.round.reveals[0]
  r.vote.answer = 'YES'
  r.signature = net.harnesses.get(r.harness).harness.sign({ harness: r.harness, ascHash: r.ascHash, vote: r.vote, salt: r.salt })
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'reveal-mismatch')
})

test('rejects a reveal with a changed salt', async () => {
  const { net, sealer, env } = await honest('fact-check')
  env.round.reveals[1].salt = '0'.repeat(32)
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'reveal-mismatch')
})

test('rejects a commitment whose signature does not verify', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.round.commits[0].signature = env.round.commits[1].signature
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'commit')
})

test('rejects a jury that does not span the contract\'s labs', async () => {
  const { net, sealer, env } = await honest('market-resolution', { harnesses: CONFIG.pool.map(h => h.id) })
  // Five seats from three labs, against a contract that requires five labs.
  const cards = sealer.harnessCards()
  env.round.jury = ['h-anthropic-1', 'h-anthropic-2', 'h-openai-1', 'h-openai-2', 'h-google-1'].map(id => cards.get(id))
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'jury-labs')
})

test('rejects a jury not drawn from the parent block hash', async () => {
  const all = CONFIG.pool.map(h => h.id)
  const { net, sealer, env } = await honest('fact-check', { harnesses: all })
  const cards = [...sealer.harnessCards().values()]
  const rules = example('fact-check').payment.jury
  let other
  for (let i = 0; ; i++) {
    other = drawJury(cards, rules, `not-the-parent-${i}`)
    if (other.map(h => h.id).join() !== env.round.jury.map(h => h.id).join()) break
  }
  env.round.jury = other
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'jury-draw')
})

test('rejects a jury whose stated seed is not the parent hash', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.round.seed = sha256('some other seed')
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'jury-draw')
})

test('declared exits only: rejects an exit the contract does not declare', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.exit = 'MAYBE'
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'exit-undeclared')
})

test('context pins checked: rejects a ruling that cites other context hashes', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.contextHashes[0] = sha256('different bytes')
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'context')
})

test('context pins checked: a contract whose content does not match its pin never enters the mempool', async () => {
  const net = await network()
  const asc = example('market-resolution')
  asc.context[0].content += ' Edited after pinning.'
  await assert.rejects(net.nodes[0].submit(asc), /hash mismatch/)
  for (const n of net.nodes) assert.equal(n.store.contracts().length, 0)
})

test('every counted vote is paid, dissent included: rejects a block that skips the dissenter', async () => {
  const { net, sealer, env } = await honest('fact-check')
  assert.equal(env.dissent.length, 1, 'the scripted fact check has one dissent')
  const dissenter = env.dissent[0].harness
  const i = env.diff.findIndex(d => d.account === `harness:${dissenter}`)
  const [skipped] = env.diff.splice(i, 1)
  env.diff.find(d => d.account === `node:${sealer.id}`).delta += skipped.delta
  assert.equal(conserves(env.diff), true, 'the tampered diff still conserves')
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'pay')
})

test('every counted vote is paid equally', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  const jurors = env.diff.filter(d => d.account.startsWith('harness:h-'))
  jurors[0].delta += 0.01
  jurors[1].delta -= 0.01
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'pay')
})

test('below the bar: rejects a block that pays jurors out of the carried escrow', async () => {
  const { net, sealer, env } = await honest('fact-check-escalation')
  assert.equal(env.passed, false)
  const carry = env.diff.find(d => d.account.endsWith(':escalation'))
  carry.delta -= 0.5
  env.diff.push({ account: `harness:${env.votes[0].harness}`, delta: 0.5 })
  assert.equal(conserves(env.diff), true)
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'pay')
})

test('proofs stay off chain: rejects a block that carries a proof', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.votes[0].proof = 'AAAA'
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'proof-on-chain')
})

test('sealer rotation: rejects a block sealed out of turn', async () => {
  const net = await network()
  await net.nodes[0].submit(example('market-resolution'))
  const wrong = net.nodes.find(n => n.id !== n.nextSealer())
  const block = await wrong.prepareBlock()
  for (const n of net.nodes) await assert.rejects(n.accept(block), err => err.code === 'sealer')
})

test('rejects a tampered header and a ruling that does not match the rulings root', async () => {
  const { net, sealer, block } = await honest('market-resolution')
  await rejectsEverywhere(net, sealer, { ...block, time: new Date(0).toISOString() }, 'hash')
  const swapped = clone(block)
  swapped.rulings[0].request = 'a different question'
  await rejectsEverywhere(net, sealer, swapped, 'root')
})

test('rejects a ruling core would not compute from its own commitments and reveals', async () => {
  const { net, sealer, env } = await honest('market-resolution')
  env.agreement = 0.5
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'replay')
})

test('bonds: a harness bonded below the contract\'s value per vote is never drawn, and a block seating one is rejected', async () => {
  const { net, sealer, env } = await honest('delay-cover')
  const low = new Harness({ id: 'h-deepseek-low', lab: 'deepseek', model: 'deepseek/deepseek-v4-flash', bond: 100, provider: null })
  for (const n of net.nodes) n.registerHarness({ card: low.card, url: 'local', signature: low.sign({ card: low.card, url: 'local' }) })
  assert.equal(example('delay-cover').payment.maxValuePerVote, 250)
  const again = await sealer.prepareBlock()
  assert.ok(!again.rulings[0].round.jury.some(c => c.id === 'h-deepseek-low'))
  env.round.jury[0] = low.card
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'jury-bond')
})

test('the sealer is paid as its node, node:<id>, and a round that pays it as a harness is rejected', async () => {
  const { net, sealer, block, env } = await honest('market-resolution')
  assert.equal(block.rulings[0].round.sealer, `node:${sealer.id}`)
  assert.ok(block.rulings[0].diff.some(d => d.account === `node:${sealer.id}` && d.delta > 0))
  assert.ok(!block.rulings[0].diff.some(d => d.account === `harness:${sealer.id}`))
  env.round.sealer = `harness:${sealer.id}`
  for (const d of env.diff) if (d.account === `node:${sealer.id}`) d.account = `harness:${sealer.id}`
  await rejectsEverywhere(net, sealer, reseal(sealer, [env]), 'pay')
})

test('a juror that commits and never reveals is not counted, is recorded as a fault, and the block is accepted', async () => {
  const net = await network()
  const quiet = net.harnesses.get('h-qwen-1').harness
  quiet.reveal = () => { throw new Error('offline') }
  await net.nodes[0].submit(example('market-resolution'))
  const block = await net.step()
  const r = block.rulings[0]
  assert.deepEqual(r.round.faults, [{ harness: 'h-qwen-1', fault: 'no-reveal' }])
  assert.ok(!r.votes.some(v => v.harness === 'h-qwen-1'))
  assert.ok(!r.diff.some(d => d.account === 'harness:h-qwen-1'))
  for (const n of net.nodes) assert.equal(n.tip().hash, block.hash)
})

test('seal time: a block timed before its parent is rejected', async () => {
  const net = await network()
  await net.nodes[0].submit(example('market-resolution'))
  await net.step()
  await net.nodes[0].submit(example('fact-check'))
  const sealer = net.sealer()
  const block = await sealer.prepareBlock()
  const early = seal(sealer.tip(), block.rulings, sealer.signer, { time: new Date(Date.parse(sealer.tip().time) - 1000).toISOString() })
  for (const n of net.nodes) await assert.rejects(n.accept(early), err => err.code === 'time')
})
