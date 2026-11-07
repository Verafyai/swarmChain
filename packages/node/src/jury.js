/**
 * Jury coordination. The node draws a jury with `drawJuryFor` from
 * `@verafyharness/core`, seeded with the parent block hash, runs the commit round
 * and then the reveal round over a juror client, and hands the recorded
 * commitments and reveals to core's `ruleFromRecords`. Core does the signature
 * checks, reveal checks, agreement, exit, diff and conservation; the node only
 * moves messages. These are the juror clients.
 * @module swarmchain/node/jury
 */

/**
 * A juror client that reaches harness processes over HTTP.
 * @param {{timeoutMs?: number}} [options] - per-request timeout.
 * @returns {{commit: (entry: object, asc: object) => Promise<object>, reveal: (entry: object, ascHash: string) => Promise<object>, proof: (entry: object, asc: object, ascHash: string) => Promise<{record: object, bundle: string}>}} the client.
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
    proof: (entry, asc, ascHash) => post(`${entry.url}/proof`, { asc, ascHash }),
  }
}

/**
 * A juror client over in-process `Harness` objects from `@verafyharness/core`, for tests.
 * @param {Map<string, {harness: object}>} byId - harnesses by id.
 * @returns {{commit: Function, reveal: Function, proof: Function}} the client.
 */
export function localJurorClient(byId) {
  return {
    commit: async (entry, asc) => byId.get(entry.card.id).harness.commit(asc),
    reveal: async (entry, ascHash) => byId.get(entry.card.id).harness.reveal(ascHash),
    // L2: a harness with a prover (`prove`) proves its revealed vote; one without has nothing to attach.
    proof: async (entry, asc) => {
      const h = byId.get(entry.card.id)
      if (!h.prove) throw new Error(`${entry.card.id} has no prover`)
      return h.prove(asc)
    },
  }
}
