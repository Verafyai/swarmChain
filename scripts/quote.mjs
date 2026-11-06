#!/usr/bin/env node
/**
 * Quote a contract's share of a proven block before funding it (offline, empty queue).
 *
 *   npm run quote -- path/to/contract.json [--tokens 800] [--escrow-ref solana:...]
 *
 * Uses the chain parameters in config/chain.json (illustrative, proposed) and
 * verafyHarness packages/economics. Every figure is modeled. A running node
 * answers the same question against its live queue at POST /quote.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { queueMeta } from '#core'
import { loadChainConfig, batchParams, quote } from '../packages/node/src/batch.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tokens: { type: 'string' }, 'escrow-ref': { type: 'string', default: 'quote' } } })
if (!positionals[0]) { console.error('usage: npm run quote -- <contract.json> [--tokens N]'); process.exit(2) }
const asc = JSON.parse(readFileSync(positionals[0], 'utf8'))
const meta = queueMeta(asc, { escrowRef: values['escrow-ref'], ...(values.tokens ? { tokens: Number(values.tokens) } : {}) })
console.log(JSON.stringify(quote(meta, [], batchParams(loadChainConfig())), null, 2))
