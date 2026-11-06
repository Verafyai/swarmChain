#!/usr/bin/env node
/**
 * Local devnet: three nodes and five harness processes on one machine.
 *
 *   npm run devnet
 *
 * Starts three Swarm Chain nodes (ports 7101 to 7103) and five harness
 * processes from verafyHarness (ports 7201 to 7205, one per lab), submits all
 * five verafyHarness example contracts, waits for five blocks, and prints each
 * block's hash as every node holds it. Exits 0 only if all three nodes hold the
 * same five blocks.
 *
 * The harnesses use the SCRIPTED provider (verafyHarness examples/mock-answers.json).
 * There is no model key here, so no model is called.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_ROOT = dirname(createRequire(import.meta.url).resolve('verafyharness/package.json'))
const NODES = [1, 2, 3].map(i => ({ id: `node-${i}`, url: `http://127.0.0.1:${7100 + i}`, port: 7100 + i }))
const HARNESSES = ['h-anthropic-1', 'h-openai-1', 'h-google-1', 'h-meta-1', 'h-qwen-1'].map((id, i) => ({ id, port: 7201 + i }))
const EXAMPLES = ['market-resolution', 'fact-check', 'forecast', 'delay-cover', 'fact-check-escalation']
const verbose = process.argv.includes('--verbose')
const children = []

function start(name, file, args) {
  const child = spawn(process.execPath, [file, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const ready = new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (verbose) console.log(`  [${name}] ${line}`)
        try {
          const e = JSON.parse(line)
          if (e.event === 'listening' || e.event === 'registered') resolve(e)
          if (e.event === 'seal-failed' || e.event === 'commit-failed' || e.event === 'reveal-failed') console.log(`  [${name}] ${line}`)
        } catch { /* not JSON */ }
      }
    })
    child.stderr.on('data', d => process.stderr.write(`  [${name}] ${d}`))
    child.on('exit', code => reject(new Error(`${name} exited with ${code}`)))
  })
  return ready
}

const get = async (url) => (await fetch(url)).json()
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const t0 = performance.now()
  console.log('Swarm Chain devnet: 3 nodes, 5 harnesses, scripted answers (no model key, no model calls)\n')
  const peers = NODES.map(n => n.url).join(',')
  await Promise.all(NODES.map(n => start(n.id, 'packages/node/bin/swarmchain-node.mjs', ['--id', n.id, '--port', String(n.port), '--peers', peers])))
  for (const n of NODES) console.log(`node     ${n.id}  ${n.url}`)
  await Promise.all(HARNESSES.map(h => start(h.id, 'scripts/harness-process.mjs', ['--id', h.id, '--port', String(h.port), '--nodes', peers])))
  const cards = await Promise.all(HARNESSES.map(h => get(`http://127.0.0.1:${h.port}/card`)))
  for (const [i, c] of cards.entries()) console.log(`harness  ${c.id.padEnd(14)} ${c.lab.padEnd(10)} ${c.model.padEnd(28)} http://127.0.0.1:${HARNESSES[i].port}`)

  // Wait until every node knows the full rotation and every harness.
  for (;;) {
    const hs = await Promise.all(NODES.map(n => get(`${n.url}/health`)))
    if (hs.every(h => h.validators.length === NODES.length && h.harnesses === HARNESSES.length)) break
    await sleep(100)
  }

  console.log('\nsubmit')
  for (const [i, name] of EXAMPLES.entries()) {
    const asc = JSON.parse(await readFile(join(HARNESS_ROOT, 'examples', `${name}.json`), 'utf8'))
    const node = NODES[i % NODES.length]
    const res = await fetch(`${node.url}/contracts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ asc }) })
    const body = await res.json()
    if (!res.ok) throw new Error(`submit ${name}: ${body.error}`)
    console.log(`  ${name.padEnd(22)} to ${node.id}  asc ${body.ascHash.slice(0, 16)}`)
  }

  const deadline = Date.now() + 60_000
  for (;;) {
    const hs = await Promise.all(NODES.map(n => get(`${n.url}/health`)))
    if (hs.every(h => h.height >= EXAMPLES.length)) break
    if (Date.now() > deadline) throw new Error(`timed out at heights ${hs.map(h => h.height).join(', ')}`)
    await sleep(100)
  }

  const chains = await Promise.all(NODES.map(n => get(`${n.url}/blocks?full=1`)))
  console.log('\nblocks, as each node holds them')
  let same = true
  for (let i = 0; i < EXAMPLES.length; i++) {
    const [a, b, c] = chains.map(ch => ch[i])
    const r = a.rulings[0]
    const match = a.hash === b.hash && b.hash === c.hash
    same &&= match
    console.log(`\n  block ${a.height}  sealed by ${a.sealer}  parent ${a.parent.slice(0, 16)}`)
    console.log(`    ${r.asc}: ${r.passed ? `${r.exit}, agreement ${Math.round(r.agreement * 100)}% against a bar of ${Math.round(r.bar * 100)}%` : `below the bar (${Math.round(r.agreement * 100)}% against ${Math.round(r.bar * 100)}%), ${r.exit}: escrow carried, no juror paid`}`)
    console.log(`    jury ${r.round.jury.join(', ')}; ${r.votes.length} counted votes, ${r.dissent.length} dissent`)
    for (const [j, n] of NODES.entries()) console.log(`    ${n.id}  ${chains[j][i].hash}`)
    console.log(`    ${match ? 'identical on all three nodes' : 'MISMATCH'}`)
  }
  const extra = chains.map(ch => ch.length)
  console.log(`\nheights ${extra.join(', ')}; ${same ? 'all five blocks identical on all three nodes' : 'nodes disagree'}`)
  console.log(`wall time ${((performance.now() - t0) / 1000).toFixed(2)} s (measured, one machine, scripted answers)`)
  console.log(`explorer  ${NODES[0].url}/  (only while the devnet runs; use --keep to leave it up)`)
  return same
}

const stop = () => { for (const c of children) c.kill('SIGTERM') }
main().then(async same => {
  if (process.argv.includes('--keep')) { console.log('running; ctrl-c to stop'); process.on('SIGINT', () => { stop(); process.exit(same ? 0 : 1) }); return }
  stop()
  process.exit(same ? 0 : 1)
}).catch(err => { console.error(err.message); stop(); process.exit(1) })
