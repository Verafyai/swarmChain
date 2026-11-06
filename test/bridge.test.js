// The Solana bridge stub: a trigger leaves the chain only with a quorum of
// counted jurors' signatures over core's trigger message: `swarm.trigger/0` at the
// pinned core, `verafy.trigger/1` once core moves. The chain never checks the kind
// itself; core's `verifyTrigger` does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { challengeContract, rulingId } from '#core'
import { network, example, SCRIPT, FIVE_LABS, SECOND_FIVE } from './helpers.js'
import { triggerMessage, signTrigger, checkTrigger, relay, TRIGGER_KIND } from '../packages/bridge-solana/src/index.js'

async function settled(options) {
  const net = await network(options)
  await net.nodes[0].submit(example('market-resolution'))
  const block = await net.step()
  const ruling = block.rulings[0]
  const msg = triggerMessage(ruling, ruling.triggers[0], { block: block.hash })
  const sign = ids => ids.map(id => signTrigger(net.harnesses.get(id).harness, msg))
  return { net, block, ruling, msg, sign, store: net.nodes[2].store }
}

test('a call trigger is verified by a quorum signature of counted jurors', async () => {
  const { block, ruling, msg, sign, store } = await settled()
  assert.ok(['swarm.trigger/0', 'verafy.trigger/1'].includes(TRIGGER_KIND), `unexpected trigger kind ${TRIGGER_KIND}`)
  assert.deepEqual(ruling.triggers, [{ type: 'call', chain: 'solana', target: 'market.settle', args: ['NO'] }])
  assert.deepEqual(msg, { kind: TRIGGER_KIND, block: block.hash, ruling: rulingId(ruling), ascHash: ruling.ascHash, trigger: ruling.triggers[0] })
  const counted = ruling.votes.map(v => v.harness)
  const quorum = example('market-resolution').payment.jury.quorum
  const ok = checkTrigger(store, msg, sign(counted.slice(0, quorum)))
  assert.equal(ok.ok, true, ok.problems.join('; '))
  assert.equal(ok.signers.length, quorum)
  assert.equal(checkTrigger(store, msg, sign(counted.slice(0, quorum - 1))).ok, false)
  const forged = sign(counted.slice(0, quorum)).map((s, i) => i === 0 ? { ...s, signature: sign([counted[quorum]])[0].signature } : s)
  assert.equal(checkTrigger(store, msg, forged).ok, false)
  const twice = [...sign(counted.slice(0, quorum - 1)), sign([counted[0]])[0]]
  assert.equal(checkTrigger(store, msg, twice).ok, false, 'a repeated signer counts once')
  const otherBlock = { ...msg, block: '0'.repeat(64) }
  assert.equal(checkTrigger(store, otherBlock, sign(counted)).ok, false)
  // The bridge's old temporary kind is refused: only core's trigger kinds verify.
  const oldKind = { ...msg, kind: 'swarmchain.trigger/0' }
  assert.equal(checkTrigger(store, oldKind, sign(counted)).ok, false)
  assert.throws(() => relay(), /milestone 5 stub/)
})

test('an overturned ruling releases no trigger, even with a quorum', async () => {
  const market = example('market-resolution')
  const yes = Object.fromEntries(Object.keys(SCRIPT[market.id]).map(lab => [lab, { answer: 'YES', confidence: 0.9, reasoning: 'Scripted YES.' }]))
  const { net, ruling, msg, sign, store } = await settled({ harnesses: [...FIVE_LABS, ...SECOND_FIVE.map(h => h.id)], extra: SECOND_FIVE, script: { ...SCRIPT, 'challenge-bridge': yes } })
  const signatures = sign(ruling.votes.map(v => v.harness))
  assert.equal(checkTrigger(store, msg, signatures).ok, true)
  await net.nodes[0].submit(challengeContract(market, ruling, { grounds: 'false-evidence', evidence: [{ kind: 'text', content: 'Forged roll call.' }], excludeLabs: [], id: 'challenge-bridge' }))
  assert.ok(await net.step())
  const after = checkTrigger(store, msg, signatures)
  assert.equal(after.ok, false)
  assert.match(after.problems.join('; '), /overturned/)
})
