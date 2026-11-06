/**
 * The availability layer: context is kept and served by its SHA-256 for at least
 * the challenge window, so anyone can re-check what a jury read. A block holds
 * only the hashes; the bytes live here.
 *
 * Every hash is computed by `@verafyharness/core`.
 * @module swarmchain/storage
 */
import { sha256 } from '#core'

/** Seven days, the default challenge window, in milliseconds. */
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export class ContextStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db - an open SQLite database.
   * @param {{windowMs?: number, now?: () => number}} [options] - the challenge window and a clock.
   */
  constructor(db, { windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.db = db
    this.windowMs = windowMs
    this.now = now
    db.exec(`CREATE TABLE IF NOT EXISTS context (
      sha256 TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      until INTEGER NOT NULL
    )`)
  }

  /**
   * Store content and keep it at least one challenge window from now.
   * @param {string} content - snapshot text.
   * @param {string} [expected] - the pinned hash; storing fails if the content does not match it.
   * @returns {string} the content's SHA-256.
   */
  put(content, expected) {
    const h = sha256(content)
    if (expected && expected !== h) throw new Error(`content does not match pin ${expected}`)
    const until = this.now() + this.windowMs
    this.db.prepare(`INSERT INTO context (sha256, content, until) VALUES (?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET until = MAX(until, excluded.until)`).run(h, content, until)
    return h
  }

  /**
   * Serve content by hash. Content is re-hashed on the way out, so a corrupted row is never served.
   * @param {string} h - SHA-256 hex.
   * @returns {string | null} the content, or null when not held.
   */
  get(h) {
    const row = this.db.prepare('SELECT content FROM context WHERE sha256 = ?').get(h)
    if (!row) return null
    return sha256(row.content) === h ? row.content : null
  }

  /**
   * Extend how long a hash must stay available, such as through a ruling's challenge window.
   * @param {string} h - SHA-256 hex.
   * @param {number} from - the time the window starts, in ms.
   */
  retain(h, from) {
    this.db.prepare('UPDATE context SET until = MAX(until, ?) WHERE sha256 = ?').run(from + this.windowMs, h)
  }

  /**
   * Drop content whose window has closed.
   * @returns {number} rows removed.
   */
  prune() {
    return Number(this.db.prepare('DELETE FROM context WHERE until < ?').run(this.now()).changes)
  }

  /**
   * HTTP route: `GET /storage/<sha256>`.
   * @param {{method: string, path: string[]}} req - the parsed request.
   * @returns {{status: number, body: unknown} | null} a response, or null if not this route.
   */
  route(req) {
    if (req.method !== 'GET' || req.path[0] !== 'storage' || req.path.length !== 2) return null
    const content = this.get(req.path[1])
    return content === null ? { status: 404, body: { error: 'not held' } } : { status: 200, body: { sha256: req.path[1], content } }
  }
}

/**
 * Fetch content by hash from other storage nodes, checking the hash before trusting it.
 * @param {string} h - SHA-256 hex.
 * @param {string[]} sources - base URLs of nodes that serve `/storage`.
 * @returns {Promise<string>} the verified content.
 */
export async function fetchContext(h, sources) {
  for (const base of sources) {
    try {
      const res = await fetch(`${base}/storage/${h}`)
      if (!res.ok) continue
      const { content } = await res.json()
      if (typeof content === 'string' && sha256(content) === h) return content
    } catch { /* try the next source */ }
  }
  throw new Error(`context ${h} is not available from any source`)
}
