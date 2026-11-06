// The first goal check, as a test: three node processes and five harness
// processes seal the five example contracts into five identical blocks, then
// close two blocks from the encrypted queue (Part C).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('devnet: five blocks, then a value close and a time close from the encrypted queue, identical on three nodes', () => {
  const script = fileURLToPath(new URL('../scripts/devnet.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 90_000 })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /all 7 blocks identical on all three nodes/)
  assert.equal((run.stdout.match(/^ {4}identical on all three nodes$/gm) ?? []).length, 7)
  assert.match(run.stdout, /no block \(below threshold\)/)
  assert.match(run.stdout, /closed by value: 3 contracts/)
  assert.match(run.stdout, /closed by time after/)
})
