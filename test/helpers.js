/**
 * Test fixtures: an in-process network of chain nodes and verafyHarness
 * harnesses (core's `Harness` with the scripted provider), joined by a local
 * gossip bus. Nothing here calls a model.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Harness, mockProvider, seal } from '#core'
import { ChainNode, localJurorClient } from '../packages/node/src/index.js'
import { LocalBus } from '../packages/gossip/src/index.js'

const HARNESS_ROOT = dirname(createRequire(import.meta.url).resolve('verafyharness/package.json'))
export const CONFIG = JSON.parse(readFileSync(join(HARNESS_ROOT, 'swarm.config.json'), 'utf8'))
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
 * Build a network.
 * @param {{nodes?: number, harnesses?: string[], script?: object}} [options] - node count, harness ids, scripted answers.
 * @returns {Promise<object>} nodes, harnesses, and helpers.
 */
export async function network({ nodes = 3, harnesses = FIVE_LABS, script = SCRIPT } = {}) {
  const hs = new Map()
  for (const id of harnesses) {
    const setup = CONFIG.pool.find(h => h.id === id)
    const harness = new Harness({ ...setup, provider: null })
    hs.set(id, { harness, before: asc => { harness.provider = mockProvider(script, asc.id, harness.lab) } })
  }
  const bus = new LocalBus()
  const list = []
  const fetchContent = async h => {
    for (const n of list) { const c = n.storage.get(h); if (c !== null) return c }
    throw new Error(`context ${h} is not available`)
  }
  for (let i = 1; i <= nodes; i++) {
    const node = new ChainNode({ id: `node-${i}`, jurors: localJurorClient(hs), fetchContent })
    node.gossip = bus.join(node)
    list.push(node)
  }
  for (const a of list) for (const b of list) if (a !== b) a.addValidator(b.card)
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
 * @returns {object} a properly linked, hashed and signed block.
 */
export function reseal(node, rulings) {
  return seal(node.tip(), rulings, node.signer)
}

/** A deep copy. */
export const clone = x => structuredClone(x)
