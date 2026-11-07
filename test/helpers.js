/**
 * Test fixtures: an in-process network of chain nodes and verafyHarness
 * harnesses (core's `Harness` with the scripted provider), joined by a local
 * gossip bus. Nothing here calls a model.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Harness, seal } from '#core'
import { mockProver, mockCommitment, l2Provider, proveVotes } from '#prove'
import { ChainNode, localJurorClient, sealTime } from '../packages/node/src/index.js'
import { LocalBus } from '../packages/gossip/src/index.js'
import { scriptedComplete } from '../scripts/scripted-panels.mjs'

const HARNESS_ROOT = dirname(createRequire(import.meta.url).resolve('verafyharness/package.json'))
// verafy.config.json after the verafyHarness rename; swarm.config.json before it.
const CONFIG_FILE = ['verafy.config.json', 'swarm.config.json'].find(f => existsSync(join(HARNESS_ROOT, f))) ?? 'verafy.config.json'
export const CONFIG = JSON.parse(readFileSync(join(HARNESS_ROOT, CONFIG_FILE), 'utf8'))
export const SCRIPT = JSON.parse(readFileSync(join(HARNESS_ROOT, 'examples', 'mock-answers.json'), 'utf8'))

/**
 * Load one of verafyHarness's example contracts.
 * @param {string} name - such as `market-resolution`.
 * @returns {object} the contract.
 */
export function example(name) {
  return JSON.parse(readFileSync(join(HARNESS_ROOT, 'examples', `${name}.json`), 'utf8'))
}

/** The first five harnesses in verafyHarness's pool: one per lab. */
export const FIVE_LABS = CONFIG.pool.slice(0, 5).map(h => h.id)

/**
 * A second harness for each of the first five labs, for challenge juries that
 * may not reuse the original jurors.
 */
export const SECOND_FIVE = CONFIG.pool.slice(0, 5).map(h => ({ ...h, id: `${h.id.replace(/-1$/, '')}-c` }))

/**
 * A harness that answers through the mock prover (scripted answers), carries
 * the mock model commitment on its card, and proves its revealed L2 votes on
 * request. L1 contracts never ask it for a proof.
 * @param {object} setup - the harness setup from the pool.
 * @param {object} script - scripted answers.
 * @returns {{harness: object, prover: object, provider: object, prove: (asc: object) => Promise<{record: object, bundle: string}>}} the harness entry.
 */
export function provingHarness(setup, script = SCRIPT, extra = {}) {
  // Scripted answers for contracts, plus ethics and amendment panels (scripts/scripted-panels.mjs).
  const prover = mockProver({ model: setup.model, complete: scriptedComplete(script, extra) })
  const provider = l2Provider(prover)
  const harness = new Harness({ ...setup, provider, modelCommitment: mockCommitment(setup.model) })
  const entry = { harness, prover, provider }
  entry.prove = async asc => {
    const [r] = await proveVotes(harness, provider, entry.prover, [asc])
    if (!r.record) throw new Error(r.error)
    return { record: r.record, bundle: r.bundle }
  }
  return entry
}

/**
 * Build a network.
 * @param {{nodes?: number, harnesses?: string[], script?: object, extra?: object[]}} [options] -
 *   node count, harness ids, scripted answers, and setups for harnesses not in verafyHarness's pool.
 * @returns {Promise<object>} nodes, harnesses, and helpers.
 */
export async function network({ nodes = 3, harnesses = FIVE_LABS, script = SCRIPT, extra = [], clock, panels = {}, config } = {}) {
  const hs = new Map()
  for (const id of harnesses) {
    const setup = CONFIG.pool.find(h => h.id === id) ?? extra.find(h => h.id === id)
    hs.set(id, provingHarness(setup, script, panels))
  }
  const bus = new LocalBus()
  const list = []
  const fetchContent = async h => {
    for (const n of list) { const c = n.storage.get(h); if (c !== null) return c }
    throw new Error(`context ${h} is not available`)
  }
  for (let i = 1; i <= nodes; i++) {
    const node = new ChainNode({ id: `node-${i}`, jurors: localJurorClient(hs), fetchContent, ...(clock ? { now: () => clock.now } : {}), ...(config ? { config } : {}) })
    node.gossip = bus.join(node)
    list.push(node)
  }
  for (const a of list) for (const b of list) if (a !== b) a.addValidator(b.card)
  // Share requests go straight to every other node's releaseShare, which checks the draw.
  for (const a of list) {
    a.peers = {
      requestShares: async draw => list.filter(b => b !== a).map(b => {
        try { return { peer: b.id, ok: true, shares: b.releaseShare(draw) } } catch (err) { return { peer: b.id, ok: false, error: err.message } }
      }),
    }
  }
  for (const n of list) for (const { harness } of hs.values()) n.registerHarness({ card: harness.card, url: 'local', signature: harness.sign({ card: harness.card, url: 'local' }) })

  const byId = id => list.find(n => n.id === id)
  return {
    nodes: list,
    harnesses: hs,
    /** The node whose turn it is to seal. */
    sealer: () => byId(list[0].nextSealer()),
    /** Every node other than `node`. */
    others: node => list.filter(n => n !== node),
    /** Seal the next block on whichever node's turn it is. */
    async step() {
      const s = byId(list[0].nextSealer())
      return s.sealNext()
    },
  }
}

/**
 * Re-seal a block's rulings with a node's key, as a dishonest sealer would after tampering.
 * @param {object} node - the sealing node.
 * @param {object[]} rulings - the (tampered) rulings.
 * @param {object[]} [reviews] - the (tampered) reviews.
 * @returns {object} a properly linked, hashed and signed block.
 */
export function reseal(node, rulings, reviews = []) {
  return seal(node.tip(), rulings, node.signer, { time: sealTime(node.tip()), reviews })
}

/** A deep copy. */
export const clone = x => structuredClone(x)
