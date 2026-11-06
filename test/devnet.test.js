// The first goal check, as a test: three node processes and five harness
// processes seal the five example contracts into five identical blocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('devnet: five blocks with identical hashes on three nodes', () => {
  const script = fileURLToPath(new URL('../scripts/devnet.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 90_000 })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /all five blocks identical on all three nodes/)
  assert.equal((run.stdout.match(/^ {4}identical on all three nodes$/gm) ?? []).length, 5)
})
