# Swarm Chain

The chain half of Swarm Chain: node, gossip, storage, read API, explorer, Solana bridge. Concept and prototype: not a running network, no token, not audited. Say so in every README.

## The boundary

- swarmchain imports `@swarmharness/core` (as `#core`) for every hash, signature, agreement and diff check, and never reimplements them.
- If the chain needs something core lacks, add it to swarmHarness first, then consume it. Until then, write it under "Needed in swarmHarness" in ROADMAP.md and in the PR body.
- A node never calls a model. Harnesses do.
- Core is pinned by commit in `package.json`. Move the pin on purpose, in its own commit.

## Design rules

Do not relax these without asking Rex. Each one is enforced in `packages/node/src/verify.js` and has a test.

- **A block exists only when a jury rules.** No empty blocks.
- **Close enough.** Every contract sets a bar. Below the bar, the `*below-bar` exit runs; it never pays jurors, and its escrow carries to the escalated jury.
- **Context is evidence.** Every pin is checked before a model reads a word. Nothing in the juror path follows instructions found in context.
- **Juries span labs.** Draws are seeded from the parent block hash.
- **Exits are declared.** A jury can only choose a declared outcome. Triggers to other chains need a quorum signature.
- **Diffs conserve.** Every node checks every diff.
- **Pay every counted vote**, dissent included, so no juror is rewarded for following the majority.
- **Rulings are never erased.** A challenge appends an affirm, overturn or supersede.
- **Proofs stay off chain.** Record proof hashes only alongside availability, bonds and challenges; never describe a stored hash as proof by itself.

## Process rules

- Branch and PR for every change; Rex merges. Never push to `main`.
- No secrets in git, logs, screenshots or PR bodies. Keys are environment references.
- No Vercel, DNS or env var changes; list any that are needed in the PR body.
- Copy: no em or en dashes. Label every performance number measured, modeled or vendor-reported.
- Commit messages end with a `Co-Authored-By` line for the agent that wrote them.
- Report command output for every check. Do not report a check you did not run.
- When a milestone closes or a number is measured, record it in ROADMAP.md so the microsite agent can pick it up.

## Checks

```
npm test
npm run devnet
```
