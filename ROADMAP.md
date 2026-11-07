# Roadmap

Verafy Chain follows the Verafy Harness milestones ([verafyHarness ROADMAP](https://github.com/Verafyai/verafyHarness/blob/main/ROADMAP.md)). This repo carries the chain side of milestones 4 and 5, and two governance milestones from the draft Constitution: the ethics gate (Article 3) and amendments (Article 5). Each milestone has a done condition that can be checked. Dates are not set.

The Constitution (`CONSTITUTION.md`) is Draft 0. It is not sealed and has no Block 0 hash: it is sealed only by a real ratification ruling (Article 6), and its text hash is computed only when the ratification contract is pinned.

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
- [x] Batching (MASTER_SPEC Part C1): an L2 block closes by value (fixed cost at most 10% of the modeled block cost, from verafyHarness `packages/economics`, and escrow that covers cost plus margin) or by time (`maxWaitSeconds`); per-contract `minBatch` and `maxWaitSeconds`; a pro rata cost split by proven requests that sums exactly to the block cost; a quote before funding (`POST /quote`, `npm run quote`). L1 contracts do not batch. Defaults in `config/chain.json` are illustrative and proposed until Rex confirms them; they change only by amendment
- [x] The encrypted queue (Part C2, prototype): contracts sealed 2 of 3 to the devnet node set, only the escrow reference and payment metadata in the clear; shares released only after the jury is drawn from the parent block hash; plaintext and pins to the availability layer at reveal (`docs/batching.md`)
- [ ] Real distributed key generation for a standing node-set queue key, and verifiable shares (planned, not built; today each author deals the shares for its own contract)
- [ ] Confidential escrow amounts where the source chain supports them, such as Token-2022 confidential transfers on a Solana cluster that enables the ZK ElGamal proof program (planned, optional; amounts are public today)
- [x] Proving (MASTER_SPEC Part D, mock prover): commit, reveal, then a signed proof record per counted vote before a proof deadline; the sealing node verifies each bundle with verafyHarness `packages/prove` and signs a check; a missing or failed proof drops the vote, re-measures agreement (escalating below the bar) and records a fault that every node keeps against the bond (`GET /faults`); every node refuses an L2 block whose proofs are unverified, checked by a non-validator, or on chain. The mock prover is not a proof of inference
- [ ] A real prover and verifier on the devnet (DeepProve or FlashProve, through the adapters in `packages/prove`); needs Rex for the DeepProve license and any machine
- [ ] Peers re-run the Verifier on the bundles themselves; today they check the sealer's signed checks and that every counted vote has one
- [ ] Pay the proving operator from the cost split (Part D); today the split is computed and shown, and nothing pays provers
- [ ] Harness daemon that takes jury seats on its own (verafyHarness; `scripts/harness-process.mjs` stands in)
- [ ] Run the escalated jury: a below-bar ruling's carried escrow funds a larger jury in a later block (core now has `escalate`; the chain does not accept escalated contracts yet, and the devnet pool cannot seat a nine-seat jury outside the original jury)
- [ ] Registry on chain: harness and validator registration by block, so draws use the registry as of the parent block
- [ ] Liveness: a missed sealer turn passes to the next node after a timeout
- [ ] Bonds and slashing on a test network; faults proven by audit, a missing reveal or a missing proof (fault records are kept per node today; nothing is slashed)
- [ ] Challenge juries that share no lab with the original jury, and challenge bonds (the chain requires that no original juror sits; core's default lab exclusion needs more labs than the test pool has, so tests pass `excludeLabs: []`)
- [ ] libp2p gossip in place of HTTP

Done when: ten independently operated harnesses, on at least five labs' models, seal blocks on a test network for a week.

### Batching check (met, 2026-11-06)

`npm run devnet`: after the five blocks above, two L2 contracts in the encrypted queue do not close a block (fixed cost 13.8% of the modeled block, over the 10% rule); a third closes block 6 by value with three rulings ($51.96 modeled block cost, $17.32 per contract); a contract with `maxWaitSeconds` 2 closes block 7 by time, alone ($5.10 modeled). All seven blocks identical on all three nodes. Figures are modeled. Since Part D, these L2 votes carry mock proof hashes too.

### Proving check (met with the mock prover, 2026-11-06)

`npm run devnet` (ports moved with `DEVNET_NODE_PORT=7500 DEVNET_HARNESS_PORT=7601`): blocks 6 and 7 carry 15 and 5 proof records, every check passed. Block 8: `h-qwen-1` sends no proof, its vote is dropped and a `no-proof` fault recorded (4 counted votes, agreement 1 against a bar of 0.8, final). Block 9: `fact-check` with a 0.9 bar (illustrative) loses `h-anthropic-1`'s proof and drops from 0.915 to 0.891, below the bar, so it escalates and carries its escrow. Block 10: `h-google-1` proves under another model commitment, the check fails, `bad-proof`. Every node holds the same three faults (bond 500 each); 33 proof hashes on chain, no proof field and no bundle text in any block, all 33 bundles held off chain. All ten blocks identical on all three nodes. The mock prover proves the flow, not the cryptography.

### First goal check (met)

`npm run devnet` on one machine, scripted answers: five blocks, identical hashes on all three nodes, sealed by node-1, node-2, node-3, node-1, node-2. The fifth (`fact-check-escalation`) rules below the bar: no juror paid, escrow carried to the escalated jury.

## Milestone 5: Solana integration

- [ ] `packages/bridge-solana`: a quorum-signed trigger relay to a devnet program matching the draft SIMDs
- [ ] A devnet prediction market resolved end to end by a Verafy Harness jury

Done when: a devnet market is created, funded, resolved by a jury, and settled by a quorum-signed call.

## Governance: the ethics gate (Constitution Article 3, prototype built on the devnet, 2026-11-06)

An ethics panel screens every contract and every governance proposal at intake, before it can enter a block, against the Embedded Ethics in the draft Constitution. Built on the devnet with scripted panel answers ([docs/governance.md](docs/governance.md)). Draft 0: it governs nothing until ratification.

- [x] Intake screening: a contract or governance proposal enters a block only after an ethics panel rules on it, with three declared outcomes: `allow`, `refuse` or `escalate`. The jury's commit round opens only after `allow`, in the same block
- [x] The panel is drawn like any jury: seeded from the parent block hash, spanning labs, commit and reveal. For the encrypted queue, the screening panel is named in the signed draw record beside the jury, and no node releases a share for a draw whose panel is wrong
- [x] Refuse: the contract never reaches a jury, its whole escrow returns to the sender (a refund diff in the block), and the ruling and its reasons are recorded on chain
- [x] Never allowed items are hard refusals: a counted refuse vote citing one keeps the first panel from allowing, and sends the subject to the wider panel
- [x] Escalate: a close call goes to a wider ethics panel with no harness from the first; if that panel cannot clear the bar, or cannot be seated, the contract is refused (doubt resolves toward refusal)
- [x] Juror refusal: a harness may decline a seat on ethics grounds (`verafy.decline/1`, verafyHarness core), never counted as a fault and never costing a bond
- [x] No bypass: no exempt flag, switch, environment variable or route around the gate; parameters have floors in code; `verify.js` rejects a block holding a contract with no `allow` ruling (`ethics-gate`). Tested with config keys, environment variables, contract fields, submit options and API parameters
- [ ] Ethics rulings can be challenged like any ruling; a challenge appends, never erases (planned: screening rulings are stored as rulings, the challenge flow does not take them yet)
- [ ] Who funds the screening fee (`ethics.fee`, illustrative 0.05 in the subject's coin): a decision for Rex
- Panel size, lab span and bar (3 seats over 3 labs, wider 5 over 4, bar 2/3): illustrative, proposed until fixed in the ratification contract

### Ethics gate check (met with scripted answers, 2026-11-06)

`npm run devnet` (ports moved with `DEVNET_NODE_PORT=7500 DEVNET_HARNESS_PORT=7601`): all twelve contracts in blocks 1 to 10 are screened `allow` by a three-harness panel first; block 11 refuses `market-goalkeeper-injury` (Never allowed 2, violence) with no jury ruling, three reasons recorded and its whole escrow (2 USDC) returned. All eleven blocks identical on all three nodes. `test/ethics.test.js` covers the close call that escalates, doubt resolving toward refusal, the hard refusal, declines, the queue, and every node rejecting a block with an unscreened or forged screening.

## Governance: amendments (Constitution Article 5, prototype built on the in-process devnet, 2026-11-06)

The seven-stage process in `AMENDMENTS.md` (Propose, Comment, Constitution check, Ethics check, Merit ruling, Challenge, Seal). Every parameter here is a **proposed** draft value, fixed only in the ratification contract for Block 0; none is measured.

1. [x] **`verafy.amendment/1` in verafyHarness core.** The contract kind and its validator: one target, declared exits, entrenched-clause list (`validateAmendment`, `ENTRENCHED`, `entrenchment`).
2. [x] **Stage rulings in the chain node.** Each stage is a `verafy.stage/1` record that cites the one before it; panel stages carry their panels' rulings. `verify.js` refuses a seal that is missing a stage, a panel that reuses a harness, the proposer's or a commenter's harness on any panel, and any amendment weakening an entrenched clause.
3. [x] **Consolidated text.** Rebuilt from Block 0 plus sealed amendments (`consolidate`, `GET /constitution`). With nothing sealed it is Block 0 exactly, so `site/build.py` still renders `CONSTITUTION.md`.
4. [x] **Devnet test.** In-process, three nodes, 42 harnesses over six labs, draft panel sizes and 14-day windows on a test clock: A-1, adding a Never allowed item, runs all seven stages and seals; A-2, removing "No treasury", stops at the constitution check (`test/governance.test.js`).
- [ ] Amendments on the multi-process devnet: the draft panels need 32 distinct harnesses; it runs five
- [ ] Withdrawal during the comment window
- [ ] The stage escrow shares (15%, 15%, 35%, illustrative) and a challenge panel bar (2/3, illustrative; AMENDMENTS.md sets none): decisions for Rex

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
14. [x] **An ethics intake hook** (for the ethics gate, Constitution Article 3). Closed without a new core function: the screening panel is an ordinary contract whose ruling core's `ruleFromRecords` and `verifyRuling` check, and the wider panel is core's `escalate`. Core added what the chain could not: signed ethics declines (`verafy.decline/1`, `checkDecline`) and the `screeningsRoot` and `governanceRoot` in `seal`.
15. [x] **`verafy.amendment/1`** (amendments, step 1). Closed by verafyHarness `governance`: `validateAmendment`, `ENTRENCHED`, `entrenchment`, `AMENDMENT_STAGES`.
16. [ ] **Trigger kind `verafy.trigger/1`.** In progress in verafyHarness: core signs new triggers as `verafy.trigger/1` and verifies both kinds. The chain never checks the kind itself; its bridge test accepts either, so the pin can move to that commit in its own commit without other changes here.
17. [x] **Proof records, checks and finality for L2.** Closed by verafyHarness `proving` (pinned 2320630): `verafy.proof/1` records, `verafy.proof-check/1` checks, the proof gate in `ruleFromRecords`, `finality`, `bondFaults`, and `packages/prove` for the Verifier.
