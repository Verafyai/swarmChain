/**
 * Solana bridge, milestone 5. A stub: it checks a trigger against the chain
 * before a relay may release it, and refuses to relay anything yet.
 *
 * A `call` trigger in a sealed ruling (for example `market.settle(NO)` on
 * Solana) may leave the chain only with signatures from at least the contract's
 * quorum of the jurors whose votes were counted. The message (`swarm.trigger/0`
 * at the pinned core; `verafy.trigger/1` once core moves, with both accepted by
 * core's verifier) and the quorum check are core's: `triggerMessage`, `signTrigger` and
 * `verifyTrigger` from `@verafyharness/core`. What the bridge adds is the chain's
 * view: the ruling is sealed in the block the message names, its contract is
 * known, and no review has overturned or superseded it.
 * @module swarmchain/bridge-solana
 */
import { triggerMessage, signTrigger, verifyTrigger, reviewStatus, TRIGGER_KIND } from '#core'

export { triggerMessage, signTrigger, verifyTrigger, TRIGGER_KIND }

/**
 * Whether a signed trigger may leave the chain.
 * @param {import('../../node/src/store.js').BlockStore} store - a node's block store.
 * @param {object} message - from core's `triggerMessage`, with `block` set.
 * @param {{harness: string, signature: string}[]} signatures - juror signatures from `signTrigger`.
 * @returns {{ok: boolean, signers: string[], problems: string[]}} the result.
 */
export function checkTrigger(store, message, signatures) {
  const sealed = store.ruling(message?.ruling)
  if (!sealed) return { ok: false, signers: [], problems: [`ruling ${message?.ruling} is not on chain`] }
  const problems = []
  if (message.block !== sealed.block) problems.push('message names a block that does not hold the ruling')
  const contract = store.contract(sealed.ruling.ascHash)
  if (!contract) problems.push('the ruling\'s contract is not known to this node')
  const status = reviewStatus(sealed.id, store.reviews(sealed.id))
  if (status === 'overturned' || status === 'superseded') problems.push(`the ruling was ${status}; it cannot release a new action`)
  const cards = new Map(store.harnesses().map(e => [e.card.id, e.card]))
  const q = verifyTrigger(message, signatures, sealed.ruling, { asc: contract?.asc, cards })
  return { ok: problems.length === 0 && q.ok, signers: q.signers, problems: [...problems, ...q.problems] }
}

/**
 * Relay a trigger to a Solana devnet program. Not built yet.
 * @returns {never}
 */
export function relay() {
  throw new Error('bridge-solana is a milestone 5 stub: no Solana program exists yet, so nothing is relayed')
}
