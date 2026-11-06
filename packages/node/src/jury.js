/**
 * Jury coordination. The node draws a jury with `drawJury` from
 * `@verafyharness/core`, seeded with the parent block hash, runs the commit round
 * and then the reveal round over a juror client, and hands the recorded
 * commitments and reveals to core's `rule` through replay jurors. Core does the
 * signature checks, reveal checks, agreement, exit, diff and conservation; the
 * node only moves messages.
 * @module swarmchain/node/jury
 */

/**
 * A juror as core's `rule` expects one, backed by recorded messages instead of a
 * live model. Every node uses these to re-run a ruling from a block.
 * @param {object} card - the registered harness card (id, lab, model, bond, publicKey).
 * @param {object | undefined} commit - the recorded commitment, if the juror committed.
 * @param {object | undefined} reveal - the recorded reveal, if the juror revealed.
 * @returns {object} a juror with `id`, `lab`, `model`, `card`, `commit` and `reveal`.
 */
export function replayJuror(card, commit, reveal) {
  return {
    id: card.id,
    lab: card.lab,
    model: card.model,
    card: { id: card.id, lab: card.lab, model: card.model, bond: card.bond, publicKey: card.publicKey },
    async commit() {
      if (!commit) throw new Error(`${card.id} did not commit`)
      return commit
    },
    reveal(h) {
      // A juror that committed but never revealed: an empty reveal fails core's checkReveal and is not counted.
      return reveal ?? { harness: card.id, ascHash: h, vote: null, salt: '', signature: '' }
    },
  }
}

/**
 * A juror client that reaches harness processes over HTTP.
 * @param {{timeoutMs?: number}} [options] - per-request timeout.
 * @returns {{commit: (entry: object, asc: object) => Promise<object>, reveal: (entry: object, ascHash: string) => Promise<object>}} the client.
 */
export function httpJurorClient({ timeoutMs = 30_000 } = {}) {
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
    return json
  }
  return {
    commit: (entry, asc) => post(`${entry.url}/commit`, { asc }),
    reveal: (entry, ascHash) => post(`${entry.url}/reveal`, { ascHash }),
  }
}

/**
 * A juror client over in-process `Harness` objects from `@verafyharness/core`, for tests.
 * @param {Map<string, {harness: object, before?: (asc: object) => void}>} byId - harnesses by id, with an optional hook run before each commit.
 * @returns {{commit: Function, reveal: Function}} the client.
 */
export function localJurorClient(byId) {
  return {
    async commit(entry, asc) {
      const h = byId.get(entry.card.id)
      h.before?.(asc)
      return h.harness.commit(asc)
    },
    async reveal(entry, ascHash) {
      return byId.get(entry.card.id).harness.reveal(ascHash)
    },
  }
}
