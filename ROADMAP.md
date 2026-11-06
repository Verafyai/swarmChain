# Roadmap

Swarm Chain follows the Swarm Harness milestones ([swarmHarness ROADMAP](https://github.com/Verafyai/swarmHarness/blob/main/ROADMAP.md)). This repo carries the chain side of milestones 4 and 5. Each milestone has a done condition that can be checked. Dates are not set.

## Milestone 4: A network of harnesses (started)

First goal: three local nodes and five harness processes seal blocks together over HTTP, every block verified by every node with `@swarmharness/core`.

- [x] Node: mempool of funded contracts, with every context pin checked on entry
- [x] Jury coordination: core's `drawJury`, seeded by the parent block hash, from harnesses bonded for the contract
- [x] Commit and reveal gossip over HTTP; every node checks every reveal against the commitment it saw
- [x] Sealer rotation by height; a node seals only on its turn and only when a contract is waiting
- [x] Block store on `node:sqlite`; blocks, rulings and reviews append-only
- [x] Block verification: rejects empty blocks, diffs that do not conserve, reveals that do not match commitments, juries that do not span labs or were not drawn from the parent hash, undeclared exits, unpaid counted votes, paid below-bar rulings, and proofs on chain
- [x] Challenges append affirm, overturn or supersede to a sealed ruling
- [x] Availability layer: context served by sha256 through the challenge window
- [x] Read API and a static explorer
- [x] Devnet script: three nodes, five harnesses, five example contracts, five identical blocks
- [ ] Harness daemon that takes jury seats on its own (swarmHarness; `scripts/harness-process.mjs` stands in)
- [ ] Run the escalated jury: a below-bar ruling's carried escrow funds a larger jury in a later block
- [ ] Registry on chain: harness and validator registration by block, so draws use the registry as of the parent block
- [ ] Liveness: a missed sealer turn passes to the next node after a timeout
- [ ] Bonds and slashing on a test network; faults proven by audit or by a missing reveal
- [ ] Challenge juries that share no lab with the original jury, and challenge bonds
- [ ] libp2p gossip in place of HTTP

Done when: ten independently operated harnesses, on at least five labs' models, seal blocks on a test network for a week.

### First goal check (met)

`npm run devnet` on one machine, scripted answers: five blocks, identical hashes on all three nodes, sealed by node-1, node-2, node-3, node-1, node-2. The fifth (`fact-check-escalation`) rules below the bar: no juror paid, escrow carried to the escalated jury.

## Milestone 5: Solana integration

- [ ] `packages/bridge-solana`: a quorum-signed trigger relay to a devnet program matching the draft SIMDs
- [ ] A devnet prediction market resolved end to end by a Swarm Harness jury

Done when: a devnet market is created, funded, resolved by a jury, and settled by a quorum-signed call.

## Needed in swarmHarness

The chain never reimplements core. These are changes the chain needs in `@swarmharness/core`; until they land, the chain works around them as noted.

1. **A ruling function over recorded messages.** `rule()` runs the commit and reveal rounds itself on in-process harness objects, and calls `reveal()` synchronously, so it cannot wait on a network. The chain runs its own rounds and replays the recorded messages through stand-in jurors. Wanted: an exported `ruleFromRecords(asc, jury, commits, reveals, sealer)`.
2. **A missing reveal is not counted.** `rule()` throws when a committed juror never reveals. The chain passes an empty reveal that fails `checkReveal`. Wanted: a missing reveal recorded as not counted (and as a fault, for slashing).
3. **A ruling verifier.** The quorum and labs-revealed test lives inline in `rule()`. The chain verifies by re-running `rule()` and comparing. Wanted: `verifyRuling(asc, ruling, records)` with reasons.
4. **Commit and reveal records in the ruling.** Core's ruling keeps vote signatures but not commitments or salts, so it cannot be re-verified from the block alone. The chain adds a `round` record (seed, jury, commits, reveals) beside it.
5. **Pay rule checks and a sealer account.** `buildDiff` pays the sealer as `harness:<sealer>`; on the chain the sealer is a node. Wanted: the caller names the sealer account, and an exported check for "every counted vote paid the same, below the bar pays nobody, escrow carried". The chain checks these itself today.
6. **Eligibility in the draw.** `drawJury` does not filter by bond, so a harness that intake would refuse can be drawn. The chain filters by `maxValuePerVote` before calling it.
7. **Harness identity load.** `Harness` makes a new Ed25519 key in its constructor, so a restarted harness is a new identity. Wanted: pass or load an identity.
8. **A scripted provider keyed per request.** `mockProvider` is bound to one contract id; a long-lived harness mounts a new one per request.
9. **Trigger quorum signatures.** Core emits `call` triggers unsigned. The bridge stub defines a temporary `swarmchain.trigger/0` message; core should own it.
10. **Challenge and escalation formats.** No challenge contract format (milestone 3) and no escalated-contract format. The chain carries `{ruling, grounds}` beside a contract and marks below-bar contracts escalated with their carried escrow.
11. **A proof hash field on votes.** Votes have no `proofHash` or model attestation field (milestone 6). The chain refuses any `proof` field on chain.
12. **The harness daemon** (swarmHarness milestone 4). `scripts/harness-process.mjs` serves a core `Harness` over HTTP until it exists.
13. **Deterministic seal time.** `seal()` stamps wall time inside the header. Fine while only the sealer seals; a time passed in would let any node rebuild a header.
