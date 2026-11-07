// The first goal check, as a test: three node processes and five harness
// processes seal the five example contracts into five identical blocks, then
// close two blocks from the encrypted queue (Part C), then three L2 proving
// blocks: a missing proof, a drop below the bar, and a wrong commitment (Part D).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('devnet: five blocks, a value close and a time close from the encrypted queue, three proving blocks, and an ethics gate refusal, identical on three nodes', () => {
  const script = fileURLToPath(new URL('../scripts/devnet.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 90_000 })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /all 11 blocks identical on all three nodes/)
  assert.equal((run.stdout.match(/^ {4}identical on all three nodes$/gm) ?? []).length, 11)
  assert.match(run.stdout, /no block \(below threshold\)/)
  assert.match(run.stdout, /closed by value: 3 contracts/)
  assert.match(run.stdout, /closed by time after/)
  assert.match(run.stdout, /one missing proof: h-qwen-1 sent no proof; fault no-proof; 4 counted votes/)
  assert.match(run.stdout, /below the bar after the drop: .*\*below-bar, escalated, escrow carried/)
  assert.match(run.stdout, /wrong model commitment: h-google-1 proved under another commitment; fault bad-proof/)
  assert.match(run.stdout, /no proof field, no bundle text; (\d+) of \1 bundles held off chain/)
  assert.match(run.stdout, /refused market-goalkeeper-injury: Never allowed 2; 0 jury rulings; 3 reasons recorded; whole escrow \(2 USDC\) returned/)
  assert.equal((run.stdout.match(/ethics gate .*: allow/g) ?? []).length, 12, 'all twelve contracts before it were screened allow')
})
