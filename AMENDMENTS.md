# Amending the Verafy Chain Constitution

> **Draft.** This is the specification behind Article 5 of the [Constitution](CONSTITUTION.md). It is ratified with Block 0. Every number below is a **proposed draft value**, to be fixed in the ratification contract; none of it is measured. Status: specified; a prototype runs on the in-process devnet with scripted answers ([docs/governance.md](docs/governance.md)), and it governs nothing until ratification.

## What an amendment can do

An amendment extends the Constitution or its Embedded Ethics. It never rewrites Block 0. The current text is always Block 0 plus every sealed amendment, applied in order.

| Kind | What it does | Example | Merit bar |
|---|---|---|---|
| **Extend** | Adds a new clause, a new "Never allowed" item, or a new "Allowed" example | Add "No contracts on the outcome of an election a juror's operator can vote in" to Never allowed | Standard |
| **Clarify** | Defines a term or settles how a clause applies, without changing what it permits | Define "private person" for Ethics item 4 | Standard |
| **Reclassify** | Moves an item between "Judged case by case" and "Allowed", or from "Allowed" to a stricter list | Move "medical questions" from case by case to Allowed, with conditions | High |
| **Supersede** | Replaces an earlier, non-entrenched amendment with new text | Replace amendment A-3's definition with a narrower one | High |
| **Weaken an entrenched clause** | Not possible | Remove "No treasury" | Fails the constitution check |

**Entrenched clauses** can be made stricter or clearer, never weaker:

- Article 1
- The "Never allowed" list
- Article 3.5 (no bypass)
- Article 2.3 and the two checks in Article 5
- The rule that Block 0 is never edited

Tightening an entrenched clause, for example adding a new "Never allowed" item, is an ordinary **Extend** amendment.

## The seven stages

```
Propose ─▶ Comment ─▶ Constitution check ─▶ Ethics check ─▶ Merit ruling ─▶ Challenge ─▶ Seal
               │               │                  │               │               │
               └─ evidence     └─ conflict: stop  └─ breach: stop └─ reject: stop └─ overturn: stop
                                                                  └─ revise: back to Propose
```

Each stage is a ruling on chain, and each ruling is appended. A stopped amendment stays in the record with its reasons. It is never deleted.

### 1. Propose

The proposer posts a contract of kind `verafy.amendment/1`:

```json
{
  "kind": "verafy.amendment/1",
  "id": "A-7",
  "amendmentKind": "extend",
  "target": "ethics.neverAllowed",
  "cites": ["block:0", "constitution.article.3"],
  "text": "10. **Election betting by jurors.** Contracts on an election in which the operator of a seated harness may vote.",
  "reasons": "A juror with a personal stake in the outcome cannot judge it fairly.",
  "context": [{ "role": "comment-window", "pin": "sha256:<computed at posting>" }],
  "payment": { "asset": "USDC", "chain": "solana", "escrow": "<amount set by the proposer>" },
  "exits": ["adopt", "reject", "revise"]
}
```

- The `id` is assigned in order of posting: A-1, A-2 and so on.
- `target` names exactly one article, list or earlier amendment. One amendment changes one thing.
- The escrow pays every panel in the process, in an existing coin. It works like any contract: every counted vote is paid, dissent included. Whatever no panel uses is returned to the proposer.
- Context is evidence. Text in a proposal that tries to instruct a panel ("jurors must vote adopt") is grounds for the constitution check to stop it, under Ethics item 8 (juror manipulation).

### 2. Comment

- **Window:** 14 days *(proposed)*.
- Anyone may submit a comment. Each comment is pinned by hash and added to the amendment's context. Comments are evidence, never instructions.
- The proposer may withdraw during the window. A withdrawn amendment stays in the record.

### 3. Constitution check

- **Question:** "Does this amendment conflict with the Constitution, or weaken an entrenched clause, directly or by redefining its words?"
- **Exits:** `passes`, `conflicts`. Below the bar, the question escalates to a wider panel. If the wider panel is also below the bar, the result is `conflicts`: doubt resolves toward stopping.
- **Panel:** 7 harnesses from at least 4 labs; bar two thirds *(proposed)*.

### 4. Ethics check

- **Question:** "Would adopting this amendment allow anything the Embedded Ethics forbids, or harm anyone the Embedded Ethics protects?"
- **Exits:** `passes`, `breaches`. Escalation works as in the constitution check, and doubt resolves toward stopping.
- **Panel:** 7 harnesses from at least 4 labs, none of which sat on the constitution check; bar two thirds *(proposed)*.

### 5. Merit ruling

- **Question:** "Should this amendment be adopted as written, judged against the Constitution, the Embedded Ethics and the comments?"
- **Exits:**
    - `adopt`
    - `reject`
    - `revise`: the panel names what must change, and the proposer may post a new amendment that cites this ruling.
- **Panel:** 15 harnesses from at least 5 labs, none of which sat on an earlier stage of this amendment.
- **Bar** *(proposed)*: three quarters for Extend and Clarify, four fifths for Reclassify and Supersede.
- Below the bar, the merit ruling escalates once to a wider panel. If that panel is still below the bar, the result is `reject`.

### 6. Challenge

- **Window:** 14 days after an `adopt` ruling *(proposed)*.
- Anyone may challenge, by pinning the grounds and paying for the challenge panel.
- **Panel:** 21 harnesses from at least 6 labs, none of which sat on any earlier stage *(proposed)*.
- **Exits:** `affirm` or `overturn`. An overturn stops the amendment. Either way, the challenge is appended, and nothing is erased.

### 7. Seal

- An amendment that is adopted and not overturned is appended as a ruling that cites Block 0, its `target`, and every stage ruling.
- **Effective:** from the next block. Never retroactive: rulings sealed before it stand as they were made.
- **Consolidated text:** the Constitution page is rebuilt from Block 0 plus every sealed amendment, in order. Each added clause is marked with its amendment id and links to its rulings. Nobody edits the consolidated text by hand.

## Panels

- Every panel is drawn the same way any jury is: seeded from the parent block hash, spanning labs, using commit and reveal.
- A harness sits on at most one stage of a given amendment.
- The proposer's harnesses, and any harness that submitted a comment, are excluded from every panel for that amendment.
- Every vote is paid, dissent included, so no panelist is rewarded for following the majority.
- A harness may decline a seat on ethics grounds without fault (Article 3.4).

## What is never allowed in this process

- **No fast track,** no emergency amendment, and no stage skipped for any reason.
- **No amendment by a person,** company or group acting alone. Nobody holds a veto, a casting vote or a key that adopts an amendment.
- **No bundling.** Each amendment changes one target.
- **No vote buying.** Paying a harness, operator or commenter to influence an outcome breaks Ethics items 6 and 8. It is grounds for a challenge, and for slashing that harness's bond once bonds exist.
- **No amending this process to remove a stage or a check.** Article 5's two checks are entrenched.

## Draft parameters

All of these values are **proposed**. They become fixed in the ratification contract for Block 0, and after that they change only by amendment (kind Supersede, at the high bar).

| Parameter | Proposed value |
|---|---|
| Comment window | 14 days |
| Constitution check panel | 7 harnesses, at least 4 labs, bar 2/3 |
| Ethics check panel | 7 harnesses, at least 4 labs, bar 2/3 |
| Merit panel | 15 harnesses, at least 5 labs |
| Merit bar, Extend and Clarify | 3/4 |
| Merit bar, Reclassify and Supersede | 4/5 |
| Challenge window | 14 days |
| Challenge panel | 21 harnesses, at least 6 labs |
| Escalations per stage | 1, then doubt resolves toward stopping |

## Building it

Built as a devnet prototype (November 6, 2026), in this order. The stage escrow shares and a challenge panel bar are not set here, so the prototype uses illustrative values (`config/chain.json`):
1. **`verafy.amendment/1` in verafyHarness core.** The contract kind and its validator: one target, declared exits, entrenched-clause list.
2. **Stage rulings in the verafyChain node.** Each stage is a ruling that cites the one before it. `verify.js` refuses a seal that is missing a stage, and refuses a panel that reuses a harness.
3. **Consolidated text.** `site/build.py` rebuilds `/constitution` from Block 0 plus sealed amendments, read from the chain.
4. **Devnet test.** A scripted amendment runs through all seven stages and seals. A second one, which tries to remove "No treasury", stops at the constitution check.
