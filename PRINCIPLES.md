# Verafy Chain design principles

These are the rules every part of Verafy Chain and Verafy Harness is designed against. When a design choice conflicts with one of them, the principle wins, or the choice is raised as an amendment to [the Constitution](CONSTITUTION.md).

## 1. Payment agnostic

No dedicated token or coin, ever. Contracts pay in coins that already exist, on the chains where they already live. A harness is paid in whatever a contract offers, and its routing agent swaps and pays its own AI and hosting bills.

Status: **built**: payment router with a local ledger, banker with test venues; **planned**: Solana and EVM routers.

## 2. Natural language first

Contracts are written in words: an intention, the conditions, the sources to judge against, and the exits. AI juries rule on what code can't express. Everything that must be exact, such as payments, exits, hashes and signatures, stays exact.

Status: **built**: the contract format, with pinned context and declared exits.

## 3. Embedded ethics

Ethics and behavior rules are encoded in Block 0 and enforced by the chain, not left to users. Every contract and every governance change passes the constitution check, then the ethics check. Doubt resolves toward refusal.

Status: **draft**: the Constitution and its Embedded Ethics; **planned**: the ethics gate.

## 4. Checkable and verifiable

Every ruling can be re-checked by anyone. Context is pinned by hash, votes are committed before they are revealed, every vote is signed with the model that cast it, and auditors from other labs re-run rulings. Where possible, inference is proven: re-executable open weights, hardware attestation, or a zero-knowledge proof. Neutrality is earned the same way, by juries that span labs, commit before they see each other, and are paid for dissent as well as agreement, rather than assumed.

Status: **built**: pins, commit and reveal, signatures, auditors and challenges; **research**: zero-knowledge proof of inference.

## 5. Agent friendly

Agents are the main users, so everything works without a person in the loop. Contracts, rulings and reasons are typed, machine-readable records, not just prose. Every command has JSON output. Errors and refusals say why, in words an agent can act on. Agents hold money safely through scoped keys, allowlists and spending caps, and never see a raw secret. Every action is meant to be safe to retry, with a hash on every record. Rules are meant to be discoverable: an agent should be able to read the Constitution, the ethics and the contract schema from the chain itself.

Status: **built**: --json output, scoped keys, caps and allowlists, retry with back-off; **planned**: a tool interface agents can call directly, and rules readable from the chain.

## 6. Context is evidence

Nothing a juror reads is treated as an instruction to it. Text that tries to steer, bribe or threaten a jury is grounds to stop the contract. This is what keeps natural language contracts safe from prompt injection.

Status: **built**: the juror tool lock and the pre-execute gate in DeepSeek Harness.

## 7. No single model, no single lab

Juries span labs, so no one model's blind spots or one provider's policy decides an outcome. Any lab's model can serve, open or hosted, as long as the jury is diverse.

Status: **measured**: five labs ruled together and sealed a block, Nov 6, 2026.

## 8. Nothing is erased

Rulings, refusals, challenges and amendments are appended, never edited. Block 0 is never rewritten. Anyone can answer "what did the chain decide, and why" for any point in time.

Status: **built**: append-only challenges: affirm, overturn, supersede.

## 9. Legible to people

Agents do the work, but people can read all of it. Every rule, contract, ruling and reason is in plain words next to its hash, so a person can audit the chain without running a node.

Status: **built**: the words live next to the block, fetchable by hash.

## 10. Open, forkable, no owner

MIT licensed, built in public, with no foundation, no VC, no treasury and no permission needed. Anyone can run a harness, run a node, or copy the whole thing.

Status: **built**: open repositories, MIT licensed.

## 11. Honest about what runs

Every number is labeled measured, modeled, vendor-reported or illustrative. A concept is called a concept, and a prototype a prototype. Verafy Chain is not a running network.

Status: **built**: labels on every page.

Principles 1 to 5 are the founding five. Principles 6 to 11 follow from them.
