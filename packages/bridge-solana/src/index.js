/**
 * Solana bridge, milestone 5. A stub: it defines the trigger message and the
 * quorum check a relay must pass, and refuses to relay anything yet.
 *
 * A `call` trigger in a sealed ruling (for example `market.settle(NO)` on
 * Solana) may leave the chain only with signatures from at least the contract's
 * quorum of the jurors whose votes were counted. Signatures are checked with
 * `@swarmharness/core`.
 * @module swarmchain/bridge-solana
 */
import { verifyMessage } from '#core'

export const TRIGGER_KIND = 'swarmchain.trigger/0'

/**
 * The message jurors sign to release one trigger.
 * @param {string} blockHash - the block that holds the ruling.
 * @param {string} rulingId - the ruling's id.
 * @param {object} trigger - the trigger as the ruling records it.
 * @returns {object} the message to sign.
 */
export function triggerMessage(blockHash, rulingId, trigger) {
  return { kind: TRIGGER_KIND, block: blockHash, ruling: rulingId, trigger }
}

/**
 * Whether a trigger carries a quorum of valid signatures from counted jurors.
 * @param {object} message - from `triggerMessage`.
 * @param {{harness: string, signature: string}[]} signatures - juror signatures.
 * @param {object} ruling - the sealed ruling (its `votes` name the counted jurors).
 * @param {Map<string, {publicKey: string}>} cards - registered harness cards.
 * @param {number} quorum - signatures required.
 * @returns {boolean} whether the quorum is met.
 */
export function hasQuorum(message, signatures, ruling, cards, quorum) {
  const counted = new Set(ruling.votes.map(v => v.harness))
  const valid = new Set()
  for (const s of signatures) {
    const card = cards.get(s.harness)
    if (counted.has(s.harness) && card && verifyMessage(card.publicKey, message, s.signature)) valid.add(s.harness)
  }
  return valid.size >= quorum
}

/**
 * Relay a trigger to a Solana devnet program. Not built yet.
 * @returns {never}
 */
export function relay() {
  throw new Error('bridge-solana is a milestone 5 stub: no Solana program exists yet, so nothing is relayed')
}
