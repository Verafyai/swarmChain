#!/usr/bin/env node
/**
 * One harness process: a `Harness` from `@verafyharness/core`, unchanged, served
 * over HTTP so nodes can seat it on a jury. This is a thin stand-in for the
 * verafyHarness harness daemon (verafyHarness milestone 4), which does not exist yet.
 *
 *   harness-process --id h-anthropic-1 --port 7201 --nodes http://127.0.0.1:7101,...
 *
 * The harness's lab, model and bond come from verafyHarness's verafy.config.json,
 * or swarm.config.json in a verafyHarness from before the rename.
 * Answers come from the SCRIPTED provider (core's mockProvider over
 * verafyHarness's examples/mock-answers.json, keyed per request by contract id
 * and lab), because there is no model key here. With `--identity <file>` the
 * harness keeps its Ed25519 key in that PEM file (core's `loadIdentity`), so a
 * restarted harness is the same harness.
 *
 * L2 (MASTER_SPEC Part D): the harness answers through the MOCK prover from
 * verafyHarness `packages/prove` (scripted answers, a mock proof that binds
 * commitment, input and answer; not a proof of inference), publishes the mock
 * model commitment on its card, and after the reveal proves its vote on request.
 *
 *   GET  /card      the public card
 *   POST /commit    { asc } -> a signed commitment
 *   POST /reveal    { ascHash } -> the signed reveal
 *   POST /proof     { asc, ascHash } -> { record, bundle }: the signed proof record (hashes only) and the off-chain bundle
 *   POST /control   { withhold?: [ascHash], wrongCommitment?: [ascHash] } (devnet only) -> withhold a proof, or prove under another model's commitment
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { Harness, mockProvider, ascHash } from '#core'
import { mockProver, mockCommitment, l2Provider, proveVotes } from '#prove'
import { scriptedComplete } from './scripted-panels.mjs'

const HARNESS_ROOT = dirname(createRequire(import.meta.url).resolve('verafyharness/package.json'))
const { values } = parseArgs({ options: { id: { type: 'string' }, port: { type: 'string' }, nodes: { type: 'string', default: '' }, identity: { type: 'string' } } })
const CONFIG_FILE = ['verafy.config.json', 'swarm.config.json'].find(f => existsSync(join(HARNESS_ROOT, f))) ?? 'verafy.config.json'
const config = JSON.parse(await readFile(join(HARNESS_ROOT, CONFIG_FILE), 'utf8'))
const script = JSON.parse(await readFile(join(HARNESS_ROOT, 'examples', 'mock-answers.json'), 'utf8'))
const setup = config.pool.find(h => h.id === values.id)
if (!setup) { console.error(`no harness "${values.id}" in verafyHarness ${CONFIG_FILE}`); process.exit(2) }

// Contracts, plus ethics screening and amendment panels (scripts/scripted-panels.mjs).
const complete = scriptedComplete(script)
const prover = mockProver({ model: setup.model, complete })
const provider = l2Provider(prover)
const harness = new Harness({ ...setup, provider, modelCommitment: mockCommitment(setup.model), ...(values.identity ? { identityFile: values.identity } : {}) })
const control = { withhold: new Set(), wrongCommitment: new Set() }
const wrongProver = mockProver({ model: `${setup.model} (not committed)`, complete })
const url = `http://127.0.0.1:${values.port}`

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const ch of req) chunks.push(ch)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
  const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
  try {
    if (req.method === 'GET' && req.url === '/card') return reply(200, harness.card)
    if (req.method === 'POST' && req.url === '/commit') {
      const c = await harness.commit(body.asc)
      console.log(JSON.stringify({ event: 'commit', harness: harness.id, asc: body.asc.id, commitment: c.commitment }))
      return reply(200, c)
    }
    if (req.method === 'POST' && req.url === '/reveal') {
      const r = harness.reveal(body.ascHash)
      console.log(JSON.stringify({ event: 'reveal', harness: harness.id, answer: r.vote.answer }))
      return reply(200, r)
    }
    if (req.method === 'POST' && req.url === '/proof') {
      const h = ascHash(body.asc)
      if (control.withhold.has(h)) { console.log(JSON.stringify({ event: 'proof-withheld', harness: harness.id, asc: body.asc.id })); return reply(409, { error: 'proof withheld (devnet control)' }) }
      const [r] = await proveVotes(harness, provider, control.wrongCommitment.has(h) ? wrongProver : prover, [body.asc])
      if (!r.record) return reply(409, { error: r.error })
      console.log(JSON.stringify({ event: 'proof', harness: harness.id, asc: body.asc.id, proofHash: r.record.proofHash }))
      return reply(200, { record: r.record, bundle: r.bundle })
    }
    if (req.method === 'POST' && req.url === '/control') {
      for (const h of body.withhold ?? []) control.withhold.add(h)
      for (const h of body.wrongCommitment ?? []) control.wrongCommitment.add(h)
      return reply(200, { withhold: [...control.withhold], wrongCommitment: [...control.wrongCommitment] })
    }
    reply(404, { error: 'no such route' })
  } catch (err) {
    reply(400, { error: err.message })
  }
})
await new Promise(r => server.listen(Number(values.port), '127.0.0.1', r))

// Register with every node, signed with this harness's own key.
const card = harness.card
const registration = { card, url, signature: harness.sign({ card, url }) }
for (const node of values.nodes.split(',').filter(Boolean)) {
  const res = await fetch(`${node}/harnesses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration) })
  if (!res.ok) { console.error(`registration with ${node} failed: ${(await res.json()).error}`); process.exit(1) }
}
console.log(JSON.stringify({ event: 'registered', harness: harness.id, lab: harness.lab, model: harness.model, url }))
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
