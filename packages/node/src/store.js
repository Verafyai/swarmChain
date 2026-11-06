/**
 * The block store: SQLite through `node:sqlite`. Blocks, rulings and reviews are
 * append-only, enforced by triggers, so a ruling is never edited or erased. A
 * challenge appends a review row (core's `swarm.review/0` record): affirm,
 * overturn or supersede.
 *
 * The mempool and harness registry live in the same database but are node
 * state, not chain state, and may change.
 * @module swarmchain/node/store
 */
import { DatabaseSync } from 'node:sqlite'

export const REVIEW_RESULTS = ['affirm', 'overturn', 'supersede']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  parent TEXT NOT NULL,
  sealer TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rulings (
  id TEXT PRIMARY KEY,
  block_hash TEXT NOT NULL REFERENCES blocks(hash),
  height INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  asc_hash TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ruling TEXT NOT NULL REFERENCES rulings(id),
  result TEXT NOT NULL CHECK (result IN ('affirm', 'overturn', 'supersede')),
  by_ruling TEXT NOT NULL REFERENCES rulings(id),
  grounds TEXT NOT NULL,
  height INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  asc_hash TEXT PRIMARY KEY,
  asc_id TEXT NOT NULL,
  json TEXT NOT NULL,
  escrow REAL NOT NULL,
  status TEXT NOT NULL,
  carried REAL NOT NULL DEFAULT 0,
  ruled_in TEXT,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS harnesses (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
`

const APPEND_ONLY = ['blocks', 'rulings', 'reviews']

export class BlockStore {
  /**
   * @param {string} [path] - database file, or ':memory:'.
   */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
    for (const t of APPEND_ONLY) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} are append-only'); END;`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} are append-only'); END;`)
    }
  }

  /** @returns {object | null} the highest block. */
  tip() {
    const row = this.db.prepare('SELECT json FROM blocks ORDER BY height DESC LIMIT 1').get()
    return row ? JSON.parse(row.json) : null
  }

  /**
   * @param {number | string} ref - a height or a block hash.
   * @returns {object | null} the block.
   */
  block(ref) {
    const row = /^\d+$/.test(String(ref))
      ? this.db.prepare('SELECT json FROM blocks WHERE height = ?').get(Number(ref))
      : this.db.prepare('SELECT json FROM blocks WHERE hash = ?').get(String(ref))
    return row ? JSON.parse(row.json) : null
  }

  /** @returns {object[]} every block, lowest first. */
  blocks() {
    return this.db.prepare('SELECT json FROM blocks ORDER BY height').all().map(r => JSON.parse(r.json))
  }

  /**
   * Append a verified block, its rulings and any reviews in one transaction.
   * @param {object} block - the block.
   * @param {{id: string, ruling: object}[]} rulings - ruling ids with their envelopes.
   * @param {object[]} reviews - core review records (`resolveChallenge`) to append.
   * @param {(store: BlockStore) => void} [also] - more writes inside the same transaction.
   */
  append(block, rulings, reviews, also) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO blocks (height, hash, parent, sealer, json) VALUES (?, ?, ?, ?, ?)').run(block.height, block.hash, block.parent, block.sealer, JSON.stringify(block))
      rulings.forEach(({ id, ruling }, i) => {
        this.db.prepare('INSERT INTO rulings (id, block_hash, height, idx, asc_hash, json) VALUES (?, ?, ?, ?, ?, ?)').run(id, block.hash, block.height, i, ruling.ascHash, JSON.stringify(ruling))
      })
      for (const r of reviews) {
        this.db.prepare('INSERT INTO reviews (ruling, result, by_ruling, grounds, height, json) VALUES (?, ?, ?, ?, ?, ?)').run(r.ruling, r.result, r.by, r.grounds, block.height, JSON.stringify(r))
      }
      also?.(this)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * @param {string} id - a ruling id.
   * @returns {{id: string, height: number, block: string, ruling: object} | null} the ruling.
   */
  ruling(id) {
    const row = this.db.prepare('SELECT id, height, block_hash, json FROM rulings WHERE id = ?').get(id)
    return row ? { id: row.id, height: row.height, block: row.block_hash, ruling: JSON.parse(row.json) } : null
  }

  /** @returns {{id: string, height: number, block: string, ruling: object}[]} every ruling, oldest first. */
  rulings() {
    return this.db.prepare('SELECT id, height, block_hash, json FROM rulings ORDER BY height, idx').all()
      .map(row => ({ id: row.id, height: row.height, block: row.block_hash, ruling: JSON.parse(row.json) }))
  }

  /**
   * @param {string} id - a ruling id.
   * @returns {object[]} its review log, oldest first: core review records, each with the height that sealed it.
   */
  reviews(id) {
    return this.db.prepare('SELECT json, height FROM reviews WHERE ruling = ? ORDER BY seq').all(id)
      .map(r => ({ ...JSON.parse(r.json), height: r.height }))
  }

  // Mempool and registry: node state, mutable.

  /**
   * @param {string} h - asc hash.
   * @returns {object | null} the mempool entry.
   */
  contract(h) {
    const row = this.db.prepare('SELECT * FROM contracts WHERE asc_hash = ?').get(h)
    return row ? rowToContract(row) : null
  }

  /** @returns {object[]} every mempool entry, in arrival order. */
  contracts() {
    return this.db.prepare('SELECT * FROM contracts ORDER BY seq').all().map(rowToContract)
  }

  /**
   * Add a contract to the mempool.
   * @param {string} h - asc hash.
   * @param {object} asc - the contract without context bytes. A challenge carries its own `review`.
   */
  addContract(h, asc) {
    const seq = Number(this.db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n)
    this.db.prepare('INSERT INTO contracts (asc_hash, asc_id, json, escrow, status, seq) VALUES (?, ?, ?, ?, ?, ?)')
      .run(h, asc.id, JSON.stringify(asc), asc.payment.escrow, 'pending', seq)
  }

  /**
   * Mark a contract settled by a block.
   * @param {string} h - asc hash.
   * @param {'ruled' | 'escalated'} status - what the ruling did.
   * @param {string} blockHash - the block that ruled.
   * @param {number} carried - escrow carried to an escalated jury.
   */
  settleContract(h, status, blockHash, carried = 0) {
    this.db.prepare('UPDATE contracts SET status = ?, ruled_in = ?, carried = ? WHERE asc_hash = ?').run(status, blockHash, carried, h)
  }

  /** @param {object} entry - a signed harness registration. */
  putHarness(entry) {
    this.db.prepare('INSERT INTO harnesses (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(entry.card.id, JSON.stringify(entry))
  }

  /** @returns {object[]} every registered harness, by id. */
  harnesses() {
    return this.db.prepare('SELECT json FROM harnesses ORDER BY id').all().map(r => JSON.parse(r.json))
  }
}

function rowToContract(row) {
  return {
    ascHash: row.asc_hash,
    id: row.asc_id,
    asc: JSON.parse(row.json),
    escrow: row.escrow,
    status: row.status,
    carried: row.carried,
    ruledIn: row.ruled_in,
  }
}
