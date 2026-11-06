# Swarm Chain

**A chain whose blocks are rulings.** Swarm Chain holds Actually Smart Contracts that are funded and waiting for a jury, coordinates juries of harnessed AI validators, gossips their commitments and reveals, seals each ruling into a block, and keeps the context every ruling read available by hash.

> Concept and prototype. Not a running network, no token, not audited. Everything here runs on one machine with scripted model answers.

## How it relates to Swarm Harness

Swarm Chain is the chain half of [Swarm Chain](https://swarmchain.verafy.ai). The validator half is [Swarm Harness](https://github.com/Verafyai/swarmHarness).

| Repo | Owns | Does not own |
|---|---|---|
| [Verafyai/swarmHarness](https://github.com/Verafyai/swarmHarness) | The harnessed validator: the contract format, context loader, juror prompt and guardrails, signer, agreement, contract runtime, the DeepSeek Harness juror plugin, the CLI, and the harness daemon. | Block storage, networking between harnesses, the chain's state. |
| Verafyai/swarmchain (this repo) | The node that holds funded contracts, jury coordination, commit and reveal gossip, sealing and block storage, the availability layer for context, bonds and slashing, the read API, the explorer, and the Solana bridge. | Anything that runs a model. A node never calls an LLM; harnesses do. |

The boundary is a rule: **every hash, signature, agreement and diff check in this repo comes from `@swarmharness/core`.** Nothing here reimplements them. When the chain needs something the core lacks, the change goes to swarmHarness first.

## Status

Milestone 4 has started. See [ROADMAP.md](ROADMAP.md).
