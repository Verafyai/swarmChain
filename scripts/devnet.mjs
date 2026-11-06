#!/usr/bin/env node
/**
 * Local devnet: three nodes and five harness processes on one machine.
 *
 *   npm run devnet
 *
 * Starts three Verafy Chain nodes (ports 7101 to 7103) and five harness
 * processes from verafyHarness (ports 7201 to 7205, one per lab), submits all
 * five verafyHarness example contracts, waits for five blocks, then runs the
 * encrypted queue (MASTER_SPEC Part C): L2 contracts sealed 2 of 3 to the nodes,
 * a queue below the value threshold that does not close, a value close, and a
 * time close. Then proving (Part D): every L2 vote carries a proof hash that the
 * sealing node verified with the mock prover's verifier; one missing proof drops
 * a vote and records a fault, a drop below the bar escalates, and a proof under
 * the wrong model commitment fails. Prints each block's hash as every node holds
 * it. Exits 0 only if all three nodes hold the same ten blocks.
 *
 * The harnesses use the SCRIPTED provider (verafyHarness examples/mock-answers.json).
 * There is no model key here, so no model is called. The mock prover is not a
 * proof of inference: it exercises the flow, not the cryptography. Each harness keeps its
 * Ed25519 key in a PEM file in a temporary directory (core's `loadIdentity`),
 * deleted when the devnet stops.
 */
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sealContract, queueMeta, ascHash } from '#core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_ROOT = dirname(createRequire(import.meta.url).resolve('verafyharness/package.json'))
// Base ports can be moved, so a devnet can run beside one that is already up.
const NODE_BASE = Number(process.env.DEVNET_NODE_PORT ?? 7100)
const HARNESS_BASE = Number(process.env.DEVNET_HARNESS_PORT ?? 7201)
const NODES = [1, 2, 3].map(i => ({ id: `node-${i}`, url: `http://127.0.0.1:${NODE_BASE + i}`, port: NODE_BASE + i }))
const HARNESSES = ['h-anthropic-1', 'h-openai-1', 'h-google-1', 'h-meta-1', 'h-qwen-1'].map((id, i) => ({ id, port: HARNESS_BASE + i }))
const EXAMPLES = ['market-resolution', 'fact-check', 'forecast', 'delay-cover', 'fact-check-escalation']
const verbose = process.argv.includes('--verbose')
const children = []
let keys = null

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
  console.log('Verafy Chain devnet: 3 nodes, 5 harnesses, scripted answers (no model key, no model calls)\n')
  const peers = NODES.map(n => n.url).join(',')
  await Promise.all(NODES.map(n => start(n.id, 'packages/node/bin/swarmchain-node.mjs', ['--id', n.id, '--port', String(n.port), '--peers', peers])))
  for (const n of NODES) console.log(`node     ${n.id}  ${n.url}`)
  keys = await mkdtemp(join(tmpdir(), 'swarmchain-devnet-'))
  await Promise.all(HARNESSES.map(h => start(h.id, 'scripts/harness-process.mjs', ['--id', h.id, '--port', String(h.port), '--nodes', peers, '--identity', join(keys, `${h.id}.pem`)])))
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

  await queuePhase()
  await provingPhase()

  const chains = await Promise.all(NODES.map(n => get(`${n.url}/blocks?full=1`)))
  const total = EXAMPLES.length + 5
  console.log('\nblocks, as each node holds them')
  let same = chains.every(ch => ch.length === total)
  for (let i = 0; i < total; i++) {
    const [a, b, c] = chains.map(ch => ch[i])
    const match = a.hash === b.hash && b.hash === c.hash
    same &&= match
    console.log(`\n  block ${a.height}  sealed by ${a.sealer}  parent ${a.parent.slice(0, 16)}${a.rulings.length > 1 ? `  ${a.rulings.length} rulings (batch)` : ''}`)
    for (const r of a.rulings) {
      console.log(`    ${r.asc}: ${r.passed ? `${r.exit}, agreement ${Math.round(r.agreement * 100)}% against a bar of ${Math.round(r.bar * 100)}%` : `below the bar (${Math.round(r.agreement * 100)}% against ${Math.round(r.bar * 100)}%), ${r.exit}: escrow carried, no juror paid`}`)
    }
    const r = a.rulings[0]
    console.log(`    jury ${r.round.jury.map(c => c.id).join(', ')}; ${r.votes.length} counted votes, ${r.dissent.length} dissent; sealer account ${r.round.sealer}`)
    if (r.round.proofRecords) {
      const records = a.rulings.flatMap(x => x.round.proofRecords)
      const checks = a.rulings.flatMap(x => x.round.proofChecks)
      const faults = a.rulings.flatMap(x => x.round.faults)
      console.log(`    L2: ${records.length} proof records (hashes only), ${checks.filter(k => k.ok).length} of ${checks.length} checks passed (mock verifier, signed by ${a.sealer}); faults ${faults.length ? faults.map(f => `${f.harness} ${f.fault}`).join(', ') : 'none'}`)
    }
    for (const [j, n] of NODES.entries()) console.log(`    ${n.id}  ${chains[j][i].hash}`)
    console.log(`    ${match ? 'identical on all three nodes' : 'MISMATCH'}`)
  }
  const extra = chains.map(ch => ch.length)
  console.log(`\nheights ${extra.join(', ')}; ${same ? `all ${total} blocks identical on all three nodes` : 'nodes disagree'}`)
  console.log(`wall time ${((performance.now() - t0) / 1000).toFixed(2)} s (measured, one machine, scripted answers)`)
  console.log(`explorer  ${NODES[0].url}/  (only while the devnet runs; use --keep to leave it up)`)
  return same
}

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(`${url}: ${json.error}`)
  return json
}
const waitHeight = async (h, ms = 30_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const hs = await Promise.all(NODES.map(n => get(`${n.url}/health`)))
    if (hs.every(x => x.height >= h)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for height ${h} (at ${hs.map(x => x.height).join(', ')})`)
    await sleep(100)
  }
}
const usd = x => `$${x.toFixed(4)}`

/** An L2 version of an example contract, with payment overrides. */
async function l2(name, payment) {
  const asc = JSON.parse(await readFile(join(HARNESS_ROOT, 'examples', `${name}.json`), 'utf8'))
  return { ...asc, payment: { ...asc.payment, ...payment, jury: { ...asc.payment.jury, assurance: 'L2' } } }
}

// The encrypted queue: L2 contracts sealed t of n, closed by value, then by time.
async function queuePhase() {
  const committee = await get(`${NODES[0].url}/queue/committee`)
  console.log(`\nencrypted queue (L2): sealed ${committee.t} of ${committee.nodes.length} to ${committee.nodes.map(n => n.id).join(', ')}; only the escrow reference and payment metadata in the clear`)
  const height = (await get(`${NODES[0].url}/health`)).height
  // Declared size 150 proven requests per contract (illustrative), escrow 30 USDC each (illustrative).
  const tokens = 150 * 1024
  const big = await Promise.all(['market-resolution', 'fact-check', 'forecast'].map(n => l2(n, { escrow: 30 })))
  const qBig = await post(`${NODES[0].url}/quote`, { meta: queueMeta(big[0], { escrowRef: 'quote', tokens }) })
  console.log(`  quote before funding, ${big[0].id} at ${tokens} declared tokens: ${qBig.requests} requests x ${qBig.jurors} jurors; share ${usd(qBig.ifClosedNow.shareUsd)} if the block closed now, ${usd(qBig.atValueRule.shareUsd)} at the value rule (${qBig.atValueRule.contracts} contracts), price with ${qBig.marginPct}% margin ${usd(qBig.atValueRule.priceUsd)} (modeled)`)
  let ref = 0
  const submit = async (asc, opts) => {
    const env = sealContract(asc, committee.nodes, { t: committee.t, escrowRef: `solana:devnet/escrow-demo-${++ref}`, ...opts })
    const node = NODES[ref % NODES.length]
    const { queueId } = await post(`${node.url}/queue`, { envelope: env })
    console.log(`  queued   ${asc.id.padEnd(32)} to ${node.id}  queue ${queueId.slice(0, 16)}  escrow ${env.meta.escrow} ${env.meta.currency}`)
  }
  await submit(big[0], { tokens })
  await submit(big[1], { tokens })
  await sleep(1500)
  const below = await get(`${NODES[0].url}/queue`)
  const v = below.status.value
  const h1 = (await get(`${NODES[0].url}/health`)).height
  console.log(`  two queued: fixed cost ${v.fixedPct.toFixed(1)}% of the block (rule: at most ${v.warmupMaxPct}%), funded ${usd(v.fundedUsd)} of ${usd(v.neededUsd)} needed; ${h1 === height ? 'no block (below threshold)' : 'UNEXPECTED BLOCK'}`)
  if (h1 !== height) throw new Error('a queue below the threshold closed')
  await submit(big[2], { tokens })
  await waitHeight(height + 1)
  const costs1 = await get(`${NODES[0].url}/costs/${height + 1}`)
  console.log(`  block ${height + 1} closed by value: ${costs1.split.shares.length} contracts, ${costs1.split.proofs} proofs, block cost ${usd(costs1.split.blockCostUsd)} of which fixed ${usd(costs1.split.fixedUsd)}; shares ${costs1.split.shares.map(s => usd(s.shareUsd)).join(' + ')} (modeled)`)

  // Time: a contract that sets its own short maximum wait (illustrative; the chain default is 3,600 s).
  const t0 = Date.now()
  await submit(await l2('delay-cover', { maxWaitSeconds: 2 }))
  await waitHeight(height + 2)
  const costs2 = await get(`${NODES[0].url}/costs/${height + 2}`)
  console.log(`  block ${height + 2} closed by time after ${((Date.now() - t0) / 1000).toFixed(1)} s (maxWaitSeconds 2): 1 contract pays the whole fixed cost, ${usd(costs2.split.blockCostUsd)} (modeled)`)
}

/** Part D: proof deadline, finality, faults against bonds, escalation, and hashes only on chain. */
async function provingPhase() {
  const committee = await get(`${NODES[0].url}/queue/committee`)
  console.log('\nproving (L2, mock prover; not a proof of inference): commit, reveal, then a proof hash per counted vote before the deadline')
  const harnessUrl = id => `http://127.0.0.1:${HARNESSES.find(h => h.id === id).port}`
  const cases = [
    { label: 'one missing proof', asc: await l2('market-resolution', { escrow: 2, maxWaitSeconds: 1 }), harness: 'h-qwen-1', control: 'withhold', expect: r => r.passed && r.votes.length === 4 },
    { label: 'below the bar after the drop', asc: await l2('fact-check', { bar: 0.9, maxWaitSeconds: 1 }), harness: 'h-anthropic-1', control: 'withhold', expect: r => !r.passed && r.exit === '*below-bar' },
    { label: 'a proof under the wrong model commitment', asc: await l2('delay-cover', { escrow: 0.7, maxWaitSeconds: 1 }), harness: 'h-google-1', control: 'wrongCommitment', expect: r => r.passed && r.votes.length === 4 },
  ]
  let ref = 100
  for (const c of cases) {
    await post(`${harnessUrl(c.harness)}/control`, { [c.control]: [ascHash(c.asc)] })
    const height = (await get(`${NODES[0].url}/health`)).height
    const env = sealContract(c.asc, committee.nodes, { t: committee.t, escrowRef: `solana:devnet/escrow-demo-${++ref}` })
    await post(`${NODES[ref % NODES.length].url}/queue`, { envelope: env })
    await waitHeight(height + 1)
    const block = await get(`${NODES[0].url}/blocks/${height + 1}`)
    const r = block.rulings[0]
    const fault = r.round.faults.find(f => f.harness === c.harness)
    console.log(`  block ${block.height} ${c.label}: ${c.harness} ${c.control === 'withhold' ? 'sent no proof' : 'proved under another commitment'}; fault ${fault?.fault ?? 'NONE'}; ${r.votes.length} counted votes; agreement ${r.agreement} against a bar of ${r.bar}; ${r.passed ? `${r.exit}, final` : `${r.exit}, escalated, escrow carried`}`)
    if (!fault || !c.expect(r)) throw new Error(`${c.label}: unexpected ruling`)
  }
  const faults = await Promise.all(NODES.map(n => get(`${n.url}/faults`)))
  const same = faults.every(f => JSON.stringify(f) === JSON.stringify(faults[0]))
  console.log(`  faults against bonds, as each node holds them: ${faults[0].map(f => `${f.harness} ${f.fault} (bond ${f.bond}, block ${f.height})`).join('; ')}; ${same ? 'identical on all three nodes' : 'MISMATCH'}`)
  if (!same || faults[0].length !== cases.length) throw new Error('fault records differ or are missing')
  // Only hashes land on chain: no proof key anywhere, no bundle text in any block; the bundles sit in the sealer's storage.
  const blocks = await get(`${NODES[0].url}/blocks?full=1`)
  const text = JSON.stringify(blocks)
  const keyed = /"proofs?":/.test(text)
  const records = blocks.flatMap(b => b.rulings.flatMap(r => (r.round.proofRecords ?? []).map(x => ({ ...x, sealer: b.sealer }))))
  let held = 0
  for (const x of records) {
    const res = await fetch(`${NODES.find(n => n.id === x.sealer).url}/storage/${x.proofHash}`)
    if (res.ok && !text.includes(JSON.stringify((await res.json()).content).slice(1, -1))) held++
  }
  console.log(`  on chain: ${records.length} proof hashes, ${keyed ? 'A PROOF FIELD' : 'no proof field'}, ${text.includes('verafy.proof-bundle/1') ? 'BUNDLE TEXT' : 'no bundle text'}; ${held} of ${records.length} bundles held off chain in the sealer's availability layer`)
  if (keyed || text.includes('verafy.proof-bundle/1') || held !== records.length) throw new Error('proof data on chain, or a bundle not held')
}

const stop = async () => {
  for (const c of children) c.kill('SIGTERM')
  if (keys) await rm(keys, { recursive: true, force: true })
}
main().then(async same => {
  if (process.argv.includes('--keep')) { console.log('running; ctrl-c to stop'); process.on('SIGINT', async () => { await stop(); process.exit(same ? 0 : 1) }); return }
  await stop()
  process.exit(same ? 0 : 1)
}).catch(async err => { console.error(err.message); await stop(); process.exit(1) })
