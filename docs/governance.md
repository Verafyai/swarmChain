# Governance in code: the ethics gate and amendments

MASTER_SPEC Part G. This is a devnet prototype of Article 3 (Embedded Ethics) and Article 5 (Amendments) of the draft [Constitution](../CONSTITUTION.md), with the process in [AMENDMENTS.md](../AMENDMENTS.md). Panels answer from scripts in tests and on the devnet; no model is called.

**Draft 0.** The Constitution and every parameter below stay Draft 0 until a real ratification ruling (Article 6). Nothing here governs anything yet, and there is no Block 0 hash: the text hash is computed only when the ratification contract is pinned.

## The ethics gate (Article 3)

Code: `packages/node/src/ethics.js`, checked by `packages/node/src/verify.js`. Tests: `test/ethics.test.js`, and the last phase of `npm run devnet`.

### What the panel reads

For every subject (a contract or an amendment proposal), the node builds a screening contract, an ordinary `verafy.asc/1` contract:

| Context | What it holds |
|---|---|
| `c0` | the subject's full text, as evidence (never as instructions) |
| `c1` | Article 3, quoted from `CONSTITUTION.md` as written (its status note left out) |
| `c2` to `c10` | the nine "Never allowed" items, one pinned policy each |
| `c11` | "Judged case by case" |
| `c12` | "Allowed" |

The question has three declared outcomes: `allow`, `refuse`, `escalate`. The panel is drawn like any jury: seeded from the parent block hash, spanning labs, with commit and reveal. Every panel ruling is checked by every node with the same draw, commit, reveal, pay and replay checks as a jury ruling.

### How it decides

| First panel | Result |
|---|---|
| clears the bar on `refuse` | refused |
| clears the bar on `allow`, and no counted `refuse` vote cites a Never allowed item | allowed |
| clears the bar on `allow`, but a counted `refuse` vote cites a Never allowed item (`c2` to `c10`) | escalated: a hard refusal is never allowed over by the first panel |
| clears the bar on `escalate`, or is below the bar | escalated |

An escalated subject goes to a wider panel that shares no harness with the first. The wider panel allows only by clearing the bar on `allow`. Anything else refuses, and so does a wider panel that cannot be seated: doubt resolves toward refusal (Article 3.3).

Design choice for Rex to confirm: a Never allowed citation forces the wider panel; it does not let a single harness refuse on its own, because Article 2.6 gives nobody a veto. At the wider panel, a minority citation counts as a refuse vote, no more.

### Refusal, escrow and reasons

A refused contract never reaches a jury. The block carries the screening entry (`verafy.screening/1`): the panels' rulings, the outcome, the Never allowed items cited, every non-allow vote's reasoning, and a refund diff that returns the **whole** escrow to the sender (`source:<escrow account>` when the contract names one, else `sender:<id>`). The node settles the contract as `refused`.

The screening panel is paid from its own escrow (`ethics.fee` in `config/chain.json`, illustrative), so Article 3.2 holds exactly: the contract's escrow goes back in full. Who posts the fee is a decision for Rex.

### Declining a seat (Article 3.4)

A harness may decline any seat, on a jury or a panel, by returning a signed `verafy.decline/1` (verafyHarness core, `Harness({ declines })`) in place of a commitment. The seat is not counted, not paid and never a fault, so it never costs a bond.

### No bypass (Article 3.5)

- Every block rule checks that each ruled contract has an `allow` screening in the same block (`ethics-gate`). A block that drops or forges one is rejected by every node.
- The node source reads no environment variable. There is no exempt flag in the contract format, the submit options, the API or the config.
- The gate's parameters have floors in code (`FLOORS` in `ethics.js`): at least 3 seats, at least 2 labs, a quorum over half, a bar over one half, a positive fee, and a wider panel larger than the first. A config below them stops the node at start.
- `test/ethics.test.js` tries config keys (`enabled: false`, `bypass`, `skip`, `exempt`, `mode: off`, and values below the floors), ten environment variables, contract fields (`ethics: "exempt"`, `gate.exempt`, `bypass`), submit options and HTTP body fields, query strings and headers. The Never allowed contract is refused every time.

### How it fits the encrypted queue (Part C)

A queued L2 contract cannot be screened when it arrives, because nobody can read it. It is screened at block close, the same way its jury gets it:

1. The sealer's signed draw record (`verafy.draw/1`) names each member's jury **and its screening panel**, both drawn from the parent block hash. The first panel depends only on the gate's rules, never on the plaintext.
2. Each node checks both draws on its own view before it releases its decryption share. A draw with a wrong screening panel gets no share.
3. With t shares, the contract opens. The screening panel is seated first. The jury's commit round opens only if the gate allows.

What stays visible: as in Part C, nodes hold the plaintext once t shares combine, and harnesses see it only when seated. The screening panel reads it before the jury does. A refused queued contract's escrow is released back on its source chain.

## Amendments (Article 5)

Format and validator: verafyHarness core (`verafy.amendment/1`, `validateAmendment`, `ENTRENCHED`, `entrenchment`). Stages: `packages/node/src/governance.js`, checked by `verify.js`. Tests: `test/governance.test.js`.

### The seven stages

Each stage is a `verafy.stage/1` record in a block's `governance` list, under a `governanceRoot` in the signed header. Each cites the record before it by id (SHA-256 of the record); `propose` cites `block:0`.

| Stage | Record | Panel (proposed, AMENDMENTS.md) |
|---|---|---|
| 1 propose | the ethics gate's screening of the proposal | screening panel, without the proposer's harnesses |
| 2 comment | the comment window closing (14 days), with every comment's hash and harness | none |
| 3 constitution-check | `passes` or `conflicts` | 7 harnesses, 4 labs, bar 2/3 |
| 4 ethics-check | `passes` or `breaches` | 7 harnesses, 4 labs, bar 2/3 |
| 5 merit | `adopt`, `reject` or `revise` | 15 harnesses, 5 labs, bar 3/4 (Extend, Clarify) or 4/5 (Reclassify, Supersede) |
| 6 challenge | `unchallenged` when the window (14 days) closes with no filing, else `affirm` or `overturn` | 21 harnesses, 6 labs; AMENDMENTS.md sets no bar, 2/3 is illustrative |
| 7 seal | cites `block:0`, the target and every stage record; effective from the next block | none |

Each panel stage's contract pins the amendment, the current Constitution (Block 0 plus sealed amendments), the stage record it follows, and every comment (and, for a challenge, every filing's grounds), all as evidence. A panel below the bar escalates once, through core's `escalate`, to a wider panel (2n minus 1 seats) of harnesses that have not sat; if that is below the bar too, or cannot be seated, the result is the stopping one.

Closing a window is not a ruling, so a comment record rides with the constitution check it opens, and an unchallenged challenge record and the seal ride the next block a jury rules ("no empty blocks").

### What `verify.js` refuses

| Rule | Code |
|---|---|
| a stage missing, out of order, citing the wrong record, or anything after a stop | `amendment-stage` |
| a harness on two panels of one amendment, or twice in one stage | `amendment-reuse` |
| the proposer's or a commenter's harness on any panel | `amendment-excluded` |
| an amendment that could weaken an entrenched clause getting past the constitution check | `amendment-entrenched` |
| a window closed early | `amendment-window` |
| a record that is not what its panels' rulings and the rules give | `amendment-result` |

The entrenchment floor: only Extend (stricter) and Clarify (clearer) may touch an entrenched clause. Whether an Extend or Clarify weakens one by redefining its words is the constitution check panel's call; the floor never lets through what the panel stops.

### Escrow

The amendment's escrow pays each panel stage a share (`amendments.stageShare`, illustrative: 15%, 15%, 35%), and what no panel used returns to the proposer at the final record (`escrow.used`, `escrow.returned`). A challenger pays for the challenge panel. AMENDMENTS.md sets no split; the shares need Rex.

### The consolidated text

`consolidate()` rebuilds the Constitution from Block 0 plus every sealed amendment, in order, marking each added clause with its amendment id and sealing block. Nothing is removed; a superseded amendment stays, marked. Every node serves it at `GET /constitution`. With nothing sealed it is Block 0 exactly, so `site/build.py` still renders `CONSTITUTION.md`; pointing the site at a node's `/constitution` waits for a chain that has sealed something.

### Routes

`POST /amendments` (`{ amendment }`), `POST /amendments/<id>/comments` (`{ comment }`), `POST /amendments/<id>/challenges` (`{ filing }`), `GET /amendments`, `GET /constitution`.

## Built, mock and planned

| Item | State |
|---|---|
| Ethics gate: screening, escalation, hard refusals, refunds, reasons, no bypass | built on the devnet; answers scripted |
| Gate in the encrypted queue: panel in the draw record, shares only after | built on the devnet |
| Ethics declines without fault | built (verafyHarness core) |
| `verafy.amendment/1` and the entrenched-clause floor | built (verafyHarness core) |
| Seven stage records, panel checks, consolidated text | built on the in-process devnet with the draft panel sizes; answers scripted |
| Amendments on the multi-process devnet | planned: it runs five harnesses, and the draft panels need 32 distinct ones |
| Challenging an ethics ruling (Article 3.6) | planned: screening rulings are stored as rulings, but the challenge flow does not take them yet |
| Withdrawing an amendment during the comment window | planned |
| Real models on panels | planned; scripted answers only |
| Ratification (Article 6), and any Block 0 hash | not started: Draft 0 |
