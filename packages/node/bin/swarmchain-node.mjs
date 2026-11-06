#!/usr/bin/env node
/**
 * Start one Swarm Chain node.
 *
 *   swarmchain-node --id node-1 --port 7101 --peers http://127.0.0.1:7102,http://127.0.0.1:7103 [--db file.db]
 *
 * Prints one JSON line per event to stdout.
 */
import { parseArgs } from 'node:util'
import { startNode } from '../src/server.js'

const { values } = parseArgs({ options: { id: { type: 'string' }, port: { type: 'string' }, peers: { type: 'string', default: '' }, db: { type: 'string', default: ':memory:' } } })
if (!values.id || !values.port) {
  console.error('usage: swarmchain-node --id <id> --port <port> [--peers url,url] [--db path]')
  process.exit(2)
}
const peers = values.peers.split(',').filter(Boolean)
const running = await startNode({ id: values.id, port: Number(values.port), peers, db: values.db, log: e => console.log(JSON.stringify(e)) })
console.log(JSON.stringify({ event: 'listening', node: values.id, url: running.url }))
await running.connect()
console.log(JSON.stringify({ event: 'connected', node: values.id, validators: [...running.node.validators.keys()] }))
process.on('SIGTERM', async () => { await running.close(); process.exit(0) })
