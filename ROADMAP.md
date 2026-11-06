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
- [ ] Pay the proving operator from the cost split (Part D); today the split is computed and shown, and nothing pays provers
- [ ] Harness daemon that takes jury seats on its own (verafyHarness; `scripts/harness-process.mjs` stands in)
- [ ] Run the escalated jury: a below-bar ruling's carried escrow funds a larger jury in a later block (core now has `escalate`; the chain does not accept escalated contracts yet, and the devnet pool cannot seat a nine-seat jury outside the original jury)
- [ ] Registry on chain: harness and validator registration by block, so draws use the registry as of the parent block
- [ ] Liveness: a missed sealer turn passes to the next node after a timeout
- [ ] Bonds and slashing on a test network; faults proven by audit or by a missing reveal
- [ ] Challenge juries that share no lab with the original jury, and challenge bonds (the chain requires that no original juror sits; core's default lab exclusion needs more labs than the test pool has, so tests pass `excludeLabs: []`)
- [ ] libp2p gossip in place of HTTP

Done when: ten independently operated harnesses, on at least five labs' models, seal blocks on a test network for a week.

### Batching check (met, 2026-11-06)

`npm run devnet`: after the five blocks above, two L2 contracts in the encrypted queue do not close a block (fixed cost 13.8% of the modeled block, over the 10% rule); a third closes block 6 by value with three rulings ($51.96 modeled block cost, $17.32 per contract); a contract with `maxWaitSeconds` 2 closes block 7 by time, alone ($5.10 modeled). All seven blocks identical on all three nodes. Figures are modeled; the votes carry no proofs yet (Part D).

### First goal check (met)

`npm run devnet` on one machine, scripted answers: five blocks, identical hashes on all three nodes, sealed by node-1, node-2, node-3, node-1, node-2. The fifth (`fact-check-escalation`) rules below the bar: no juror paid, escrow carried to the escalated jury.

## Milestone 5: Solana integration

- [ ] `packages/bridge-solana`: a quorum-signed trigger relay to a devnet program matching the draft SIMDs
- [ ] A devnet prediction market resolved end to end by a Verafy Harness jury

Done when: a devnet market is created, funded, resolved by a jury, and settled by a quorum-signed call.

## Governance: the ethics gate (Constitution Article 3, planned)

An ethics panel screens every contract and every governance proposal at intake, before it can enter a block, against the Embedded Ethics in the draft Constitution. Status: planned, not built. The harness guardrails exist today; the gate as a separate panel does not.

- [ ] Intake screening: a contract or governance proposal enters the mempool only after an ethics panel rules on it, with three declared outcomes: `allow`, `refuse` or `escalate`
- [ ] The panel is drawn like any jury: seeded from the parent block hash, spanning labs, commit and reveal
- [ ] Refuse: the contract never reaches a jury, its escrow returns to the sender, and the ruling and its reasons are recorded on chain
- [ ] Escalate: a close call goes to a wider ethics panel; if that panel cannot clear the bar either, the contract is refused (doubt resolves toward refusal)
- [ ] Juror refusal: a harness may decline a seat on ethics grounds, never counted as a fault and never costing a bond
- [ ] No bypass: no exempt flag, switch or route around the gate; `verify.js` rejects a block holding a contract with no `allow` ruling
- [ ] Ethics rulings can be challenged like any ruling; a challenge appends, never erases
- Panel size, lab span and bar: not set; any value chosen is proposed until fixed in the ratification contract

Done when: on the devnet, a contract from the Allowed list is screened `allow` and sealed, a contract from the Never allowed list is screened `refuse` with its escrow returned and its reasons recorded, a close call escalates, and a block carrying an unscreened contract is rejected by every node.

## Governance: amendments (Constitution Article 5, specified, not built)

The seven-stage process in `AMENDMENTS.md` (Propose, Comment, Constitution check, Ethics check, Merit ruling, Challenge, Seal). Every parameter here is a **proposed** draft value, fixed only in the ratification contract for Block 0; none is measured.

1. [ ] **`verafy.amendment/1` in verafyHarness core.** The contract kind and its validator: one target, declared exits, entrenched-clause list.
2. [ ] **Stage rulings in the chain node.** Each stage is a ruling that cites the one before it. `verify.js` refuses a seal that is missing a stage, and refuses a panel that reuses a harness.
3. [ ] **Consolidated text.** `site/build.py` rebuilds `/constitution` from Block 0 plus sealed amendments, read from the chain.
4. [ ] **Devnet test.** A scripted amendment runs through all seven stages and seals. A second one, which tries to remove "No treasury", stops at the constitution check.

Proposed parameters (all proposed, from `AMENDMENTS.md`):

| Parameter | Proposed value |
|---|---|
| Comment window | 14 days (proposed) |
| Constitution check panel | 7 harnesses, at least 4 labs, bar 2/3 (proposed) |
| Ethics check panel | 7 harnesses, at least 4 labs, bar 2/3 (proposed) |
| Merit panel | 15 harnesses, at least 5 labs (proposed) |
| Merit bar, Extend and Clarify | 3/4 (proposed) |
| Merit bar, Reclassify and Supersede | 4/5 (proposed) |
| Challenge window | 14 days (proposed) |
| Challenge panel | 21 harnesses, at least 6 labs (proposed) |
| Escalations per stage | 1, then doubt resolves toward stopping (proposed) |

Done when: step 4 passes on the devnet with the proposed parameters, both amendments stay in the record with their stage rulings, and the rebuilt `/constitution` shows the sealed one marked with its amendment id.

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
14. [ ] **An ethics intake hook** (for the ethics gate, Constitution Article 3). A core function the node calls when a contract or governance proposal arrives, before it can enter the mempool: it seats an ethics panel and returns a ruling with exits `allow`, `refuse` or `escalate` and its reasons, in a record `verifyRuling` can check, plus a refund diff that returns escrow to the sender on `refuse`. No option exempts a contract from it. Until it exists, the chain screens nothing and says so.
15. [ ] **`verafy.amendment/1`** (amendments, step 1). The contract kind and its validator, as listed under the amendments milestone.
16. [ ] **Trigger kind `verafy.trigger/1`.** In progress in verafyHarness: core signs new triggers as `verafy.trigger/1` and verifies both kinds. The chain never checks the kind itself; its bridge test accepts either, so the pin can move to that commit in its own commit without other changes here.
