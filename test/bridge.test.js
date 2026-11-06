// The Solana bridge stub: triggers leave the chain only with a quorum of counted jurors' signatures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '#core'
import { network, example } from './helpers.js'
import { triggerMessage, hasQuorum, relay } from '../packages/bridge-solana/src/index.js'

test('a call trigger needs signatures from a quorum of counted jurors', async () => {
  const net = await network()
  await net.nodes[0].submit(example('market-resolution'))
  const block = await net.step()
  const ruling = block.rulings[0]
  assert.deepEqual(ruling.triggers, [{ type: 'call', chain: 'solana', target: 'market.settle', args: ['NO'] }])
  const msg = triggerMessage(block.hash, sha256(ruling), ruling.triggers[0])
  const cards = net.nodes[0].harnessCards()
  const sign = ids => ids.map(id => ({ harness: id, signature: net.harnesses.get(id).harness.sign(msg) }))
  const counted = ruling.votes.map(v => v.harness)
  const quorum = example('market-resolution').payment.jury.quorum
  assert.equal(hasQuorum(msg, sign(counted.slice(0, quorum)), ruling, cards, quorum), true)
  assert.equal(hasQuorum(msg, sign(counted.slice(0, quorum - 1)), ruling, cards, quorum), false)
  const forged = sign(counted.slice(0, quorum)).map((s, i) => i === 0 ? { ...s, signature: sign([counted[quorum]])[0].signature } : s)
  assert.equal(hasQuorum(msg, forged, ruling, cards, quorum), false)
  assert.throws(() => relay(), /milestone 5 stub/)
})
