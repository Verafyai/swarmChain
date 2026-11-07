/**
 * Gossip between nodes over HTTP. Six message types travel:
 *
 *   contract   a funded contract entering the mempool, without its context bytes
 *   sealed     a contract entering the encrypted queue, sealed t of n to the nodes
 *   queue-open a queued contract's key, released after its jury was drawn
 *   commit     a juror's signed commitment to a hidden vote
 *   reveal     a juror's signed reveal of that vote
 *   block      a sealed block
 *
 * Messages are identified by their SHA-256 (from `@verafyharness/core`), seen
 * messages are dropped, and new ones are relayed to every peer. HTTP first;
 * libp2p later.
 * @module swarmchain/gossip
 */
import { sha256 } from '#core'

export const MESSAGE_TYPES = ['contract', 'sealed', 'queue-open', 'commit', 'reveal', 'block', 'amendment', 'comment', 'filing']

export class Gossip {
  /**
   * @param {{self: string, peers?: string[], deliver: (type: string, msg: object, from: string) => Promise<void> | void}} options -
   *   this node's base URL, peer base URLs, and the handler for new messages.
   */
  constructor({ self, peers = [], deliver }) {
    this.self = self
    this.peers = peers.filter(p => p !== self)
    this.deliver = deliver
    this.seen = new Set()
  }

  /**
   * Publish a message to every peer.
   * @param {string} type - one of MESSAGE_TYPES.
   * @param {object} msg - the payload.
   * @returns {Promise<{peer: string, ok: boolean, error?: string}[]>} delivery results.
   */
  async broadcast(type, msg) {
    if (!MESSAGE_TYPES.includes(type)) throw new Error(`unknown gossip type "${type}"`)
    const id = sha256({ type, msg })
    this.seen.add(id)
    return this.#send({ id, type, msg, from: this.self })
  }

  async #send(envelope, except = []) {
    return Promise.all(this.peers.filter(p => !except.includes(p)).map(async peer => {
      try {
        const res = await fetch(`${peer}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
        const body = await res.json().catch(() => ({}))
        return { peer, ok: res.ok, error: res.ok ? undefined : body.error }
      } catch (err) {
        return { peer, ok: false, error: String(err.message ?? err) }
      }
    }))
  }

  /**
   * Handle an incoming envelope: drop it if seen, otherwise deliver and relay.
   * A message the node rejects is not relayed.
   * @param {{id: string, type: string, msg: object, from: string}} envelope - the gossip envelope.
   * @returns {Promise<{status: number, body: object}>} the response for the sender.
   */
  async receive(envelope) {
    const { type, msg, from } = envelope ?? {}
    if (!MESSAGE_TYPES.includes(type)) return { status: 400, body: { error: `unknown gossip type "${type}"` } }
    const id = sha256({ type, msg })
    if (id !== envelope.id) return { status: 400, body: { error: 'envelope id does not match its message' } }
    if (this.seen.has(id)) return { status: 200, body: { seen: true } }
    this.seen.add(id)
    try {
      await this.deliver(type, msg, from)
    } catch (err) {
      this.seen.delete(id)
      return { status: 422, body: { error: err.message, code: err.code } }
    }
    await this.#send({ id, type, msg, from: this.self }, [from])
    return { status: 200, body: { accepted: true } }
  }

  /**
   * HTTP route: `POST /gossip`.
   * @param {{method: string, path: string[], body: unknown}} req - the parsed request.
   * @returns {Promise<{status: number, body: unknown}> | null} a response, or null if not this route.
   */
  route(req) {
    if (req.method !== 'POST' || req.path[0] !== 'gossip' || req.path.length !== 1) return null
    return this.receive(req.body)
  }
}

/**
 * An in-process bus with the same `broadcast` shape, for tests: delivers a
 * message straight to every other node's handler.
 */
export class LocalBus {
  constructor() { this.members = [] }

  /**
   * Join a node to the bus.
   * @param {{id: string, handleGossip: (type: string, msg: object) => Promise<void>}} node - a chain node.
   * @returns {{broadcast: (type: string, msg: object) => Promise<object[]>}} its gossip handle.
   */
  join(node) {
    this.members.push(node)
    return {
      broadcast: async (type, msg) => {
        const out = []
        for (const m of this.members) {
          if (m === node) continue
          try { await m.handleGossip(type, msg); out.push({ peer: m.id, ok: true }) } catch (err) { out.push({ peer: m.id, ok: false, error: err.message }) }
        }
        return out
      },
    }
  }
}
