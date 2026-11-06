# Roadmap

Swarm Chain follows the Verafy Harness milestones ([verafyHarness ROADMAP](https://github.com/Verafyai/verafyHarness/blob/main/ROADMAP.md)). This repo carries the chain side of milestones 4 and 5. Each milestone has a done condition that can be checked. Dates are not set.

## Milestone 4: A network of harnesses (started)

First goal: three local nodes and five harness processes seal blocks together over HTTP, every block verified by every node with `@verafyharness/core`.

- [x] Node: mempool of funded contracts, with every context pin checked on entry
- [x] Jury coordination: core's `drawJuryFor` (bond floor and exclusions applied), seeded by the parent block hash; rulings from core's `ruleFromRecords`, re-verified with core's `verifyRuling`
- [x] Commit and reveal gossip over HTTP; every node checks every reveal against the commitment it saw
- [x] Sealer rotation by height; a node seals only on its turn and only when a contract is waiting
- [x] Block store on `node:sqlite`; blocks, rulings and reviews append-only
- [x] Block verification: rejects empty blocks, diffs that do not conserve, reveals that do not match commitments, juries that do not span labs or were not drawn from the parent hash, undeclared exits, unpaid counted votes, paid below-bar rulings, and proofs on chain
- [x] Challenges append affirm, overturn or supersede to a sealed ruling: core's `challengeContract` format, `resolveChallenge` reviews sealed under the block's `reviewsRoot`, original jurors kept off the challenge jury
- [x] Availability layer: context served by sha256 through the challenge window
- [x] Read API and a static explorer
- [x] Devnet script: three nodes, five harnesses, five example contracts, five identical blocks
- [ ] Harness daemon that takes jury seats on its own (verafyHarness; `scripts/harness-process.mjs` stands in)
- [ ] Run the escalated jury: a below-bar ruling's carried escrow funds a larger jury in a later block (core now has `escalate`; the chain does not accept escalated contracts yet, and the devnet pool cannot seat a nine-seat jury outside the original jury)
- [ ] Registry on chain: harness and validator registration by block, so draws use the registry as of the parent block
- [ ] Liveness: a missed sealer turn passes to the next node after a timeout
- [ ] Bonds and slashing on a test network; faults proven by audit or by a missing reveal
- [ ] Challenge juries that share no lab with the original jury, and challenge bonds (the chain requires that no original juror sits; core's default lab exclusion needs more labs than the test pool has, so tests pass `excludeLabs: []`)
- [ ] libp2p gossip in place of HTTP

Done when: ten independently operated harnesses, on at least five labs' models, seal blocks on a test network for a week.

### First goal check (met)

`npm run devnet` on one machine, scripted answers: five blocks, identical hashes on all three nodes, sealed by node-1, node-2, node-3, node-1, node-2. The fifth (`fact-check-escalation`) rules below the bar: no juror paid, escrow carried to the escalated jury.

## Milestone 5: Solana integration

- [ ] `packages/bridge-solana`: a quorum-signed trigger relay to a devnet program matching the draft SIMDs
- [ ] A devnet prediction market resolved end to end by a Verafy Harness jury

Done when: a devnet market is created, funded, resolved by a jury, and settled by a quorum-signed call.

## Needed in verafyHarness

The chain never reimplements core. These are the changes the chain asked of `@verafyharness/core`. verafyHarness PR #6 (commit 47a495e, pinned here) closed every one except the harness daemon, and the chain's workarounds for them are gone.

1. [x] **A ruling function over recorded messages.** Closed by `ruleFromRecords(asc, commits, reveals, {jury, sealer, seed})`. The chain's replay jurors are removed.
2. [x] **A missing reveal is not counted.** Closed: a juror that never reveals is not counted and is listed in `round.faults` as `no-reveal`. The empty-reveal workaround is removed.
3. [x] **A ruling verifier.** Closed by `verifyRuling(asc, ruling, {cards, pool, seed})`, with reasons. The chain no longer re-runs `rule()` and compares.
4. [x] **Commit and reveal records in the ruling.** Closed: core's ruling carries `round` (seed, jury cards, commits, reveals, faults, sealer account). The chain's own `round` is removed.
5. [x] **Pay rule checks and a sealer account.** Closed by `accountFor` and the sealer account option (the chain pays the sealer as `node:<id>`) and by `checkPay`. The chain's own pay checks are removed.
6. [x] **Eligibility in the draw.** Closed by `drawJury(..., {minBond})`, `drawJuryFor` and `eligibleJurors`. The chain's own bond filter is removed.
7. [x] **Harness identity load.** Closed by `importIdentity`, `exportIdentity`, `loadIdentity` and `Harness({identity, identityFile})`. Harness processes take `--identity <file>`; the devnet keeps keys in a temporary directory. A node also takes an `identity`.
8. [x] **A scripted provider keyed per request.** Closed: `mockProvider(script)` without a bound contract. Per-request remounting is removed.
9. [x] **Trigger quorum signatures.** Closed by `trigger.js`: `swarm.trigger/0`, `triggerMessage`, `signTrigger`, `verifyTrigger`. The bridge's temporary `swarmchain.trigger/0` format and `hasQuorum` are removed.
10. [x] **Challenge and escalation formats.** Closed by `challenge.js` (`challengeContract`, `resolveChallenge`, `appendReview`, `escalate`, `audit`) and `asc.review` / `asc.escalation`. The chain's `{ruling, grounds}` side record and its own review rule are removed. Running the escalated jury is chain work, listed under milestone 4.
11. [x] **A proof hash field on votes.** Closed: votes may carry a `proofHash`; core refuses a `proof` on a vote. The chain still refuses any `proof` field anywhere in a block.
12. [ ] **The harness daemon** (verafyHarness milestone 4). Still open in verafyHarness. `scripts/harness-process.mjs` serves a core `Harness` over HTTP until it exists.
13. [x] **Deterministic seal time.** Closed: `seal(parent, rulings, sealer, {time, reviews})`, with `blockHeader` (including `reviewsRoot`). The sealer passes its clock, always after the parent's time; every node checks the time moves forward and is no more than 60 s ahead of its own clock. Block hashes still differ run to run, because core draws a random salt for every commitment.
