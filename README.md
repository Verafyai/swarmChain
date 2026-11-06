# Swarm Chain

**A chain whose blocks are rulings.** Swarm Chain holds Actually Smart Contracts that are funded and waiting for a jury, coordinates juries of harnessed AI validators, gossips their commitments and reveals, seals each ruling into a block, and keeps the context every ruling read available by hash.

> Concept and prototype. Not a running network, no token, not audited. Everything here runs on one machine with scripted model answers.

## How it relates to Swarm Harness

Swarm Chain is the chain half of [Swarm Chain](https://swarmchain.verafy.ai). The validator half is [Swarm Harness](https://github.com/Verafyai/swarmHarness).

| Repo | Owns | Does not own |
|---|---|---|
| [Verafyai/swarmHarness](https://github.com/Verafyai/swarmHarness) | The harnessed validator: the contract format, context loader, juror prompt and guardrails, signer, agreement, contract runtime, the DeepSeek Harness juror plugin, the CLI, and the harness daemon. | Block storage, networking between harnesses, the chain's state. |
| Verafyai/swarmchain (this repo) | The node that holds funded contracts, jury coordination, commit and reveal gossip, sealing and block storage, the availability layer for context, bonds and slashing, the read API, the explorer, and the Solana bridge. | Anything that runs a model. A node never calls an LLM; harnesses do. |

The boundary is a rule: **every hash, signature, agreement and diff check in this repo comes from `@swarmharness/core`.** Nothing here reimplements them. When the chain needs something the core lacks, the change goes to swarmHarness first. Known gaps are listed in [ROADMAP.md](ROADMAP.md#needed-in-swarmharness).

## Quick start

Needs Node 22.13 or later (for `node:sqlite`). No other dependencies.

```sh
git clone https://github.com/Verafyai/swarmchain.git
cd swarmchain
npm install       # fetches @swarmharness/core from GitHub at a pinned commit
npm test          # node:test suite, including the devnet check
npm run devnet    # three nodes, five harnesses, five example contracts, five blocks
```

`npm run devnet` starts three nodes (ports 7101 to 7103) and five harness processes (ports 7201 to 7205), submits the five swarmHarness example contracts, and prints every block's hash as each node holds it. It exits 0 only when all three nodes hold the same five blocks. Add `--keep` to leave it running and open the explorer at http://127.0.0.1:7101/, or `--verbose` to see every event.

**The harnesses use the scripted provider.** There is no model key in this repo or its devnet, so each harness answers from swarmHarness's `examples/mock-answers.json` through core's `mockProvider`. No model is called. Swapping in live models is a swarmHarness concern (`--live`, `SWARM_API_KEY`), not a chain one.

### How @swarmharness/core is consumed

npm cannot install one folder of a git repository, so `package.json` depends on the whole swarmHarness repo at a pinned commit and maps `#core` to the core package inside it:

```json
"dependencies": { "swarmharness": "github:Verafyai/swarmHarness#8a0ab46" },
"imports": { "#core": "swarmharness/packages/swarm-core/src/index.js" }
```

Every module here imports `#core`. To develop against a local swarmHarness checkout, install it in place without saving: `npm install --no-save ../swarmHarness`. To move the pin, change the commit in `package.json` and run `npm install`.

## What a node does

```
 requester            node (any of three)                    harness processes
     |  POST /contracts    |                                         |
     |-------------------->| validate, check every pin,              |
     |                     | keep bytes in storage, gossip contract  |
     |                     |                                         |
     |      sealer for this height (rotation by id)                  |
     |                     | draw jury, seeded by parent block hash  |
     |                     |---------------- POST /commit ---------->| deliberate, commit
     |                     |<--------------- commitment -------------|
     |                     | gossip commit to every node             |
     |                     |---------------- POST /reveal ---------->|
     |                     |<--------------- reveal -----------------|
     |                     | gossip reveal; every node checks it     |
     |                     | against the commitment it saw           |
     |                     | core rule() from the recorded messages  |
     |                     | core seal(); verify own block; gossip   |
     |                     |                                         |
     |      every other node: verify the block with core, append     |
```

1. **Mempool.** A contract enters only if `validate` passes and every context pin matches its bytes (`loadContext`). Bytes go to the availability layer; the contract is stored and gossiped as hashes. Peers fetch the bytes by hash from the node that has them and check each hash.
2. **Sealer rotation.** Validators take turns by height, in id order. Only the node whose turn it is may seal, and only when a contract is waiting. No contract, no block.
3. **Jury.** `drawJury` from core, from harnesses whose bond covers the contract's value per vote, seeded by the parent block hash.
4. **Commit, then reveal.** The reveal round opens only after the commit round closes. Every node checks each gossiped commitment's signature, and each reveal against the commitment it saw.
5. **Rule and seal.** Core's `rule` runs over the recorded commitments and reveals, then core's `seal` links the block to its parent. The sealer verifies its own block exactly as every peer will.

## What every node checks on every block

| Rule | Check | Rejection code |
|---|---|---|
| A block exists only when a jury rules | at least one ruling | `empty` |
| Proofs stay off chain | no `proof` or `proofs` field anywhere | `proof-on-chain` |
| Linked, hashed, signed by the right sealer | height, parent, `sha256(header)`, rotation, Ed25519 | `link`, `hash`, `sealer` |
| Rulings root | recomputed from the rulings | `root` |
| Context is evidence | every pin matches bytes the node holds, and the ruling cites exactly the pinned hashes | `context` |
| Juries span labs | distinct labs at least `minLabs` | `jury-labs` |
| Bonds cover the vote | every juror's bond at least `maxValuePerVote` | `jury-bond` |
| Draw seeded by parent hash | seed is the parent hash and the jury is core's draw from it | `jury-draw` |
| Commitments are genuine | signed by the registered key, for this contract | `commit`, `commit-equivocation` |
| Reveals match commitments | core `checkReveal` and signature | `reveal-mismatch` |
| Exits are declared | the exit and every vote are declared outcomes; below the bar takes `*below-bar` | `exit-undeclared` |
| Diffs conserve | core `conserves` | `diff-conserve` |
| Pay every counted vote | every counted vote paid the same, dissent included; below the bar nobody is paid and the whole escrow carries to the escalated jury | `pay` |
| Core agrees | core `rule` re-run from the recorded messages gives the identical ruling | `replay` |
| Rulings are never erased | a challenge's review result is what the rulings SIMD says it must be | `review` |

Blocks, rulings and reviews are append-only in SQLite: triggers abort any `UPDATE` or `DELETE`. A challenge is a new contract that names a sealed ruling and its grounds (`new-evidence`, `false-evidence`, `error`, `changed-rules`). Its ruling appends `affirm`, `overturn` or `supersede` to the original's review history; below the bar, the original stands and nothing is appended.

## Read API

Each node serves it, read only, with CORS open for the explorer.

| Route | Returns |
|---|---|
| `GET /blocks` | block headers, lowest first; `?full=1` for whole blocks |
| `GET /blocks/<height or hash>` | one block |
| `GET /rulings` | every ruling with its review status |
| `GET /rulings/<id>` | one ruling: votes, dissent, diff, triggers, jury, seed and every review |
| `GET /contracts` | the mempool: pending, ruled and escalated, with carried escrow |
| `GET /contracts/<ascHash>` | one contract, with context as hashes |
| `GET /harnesses` | registered harnesses and their records: seated, counted, dissents, earned |
| `GET /accounts` | balances implied by every sealed diff |
| `GET /storage/<sha256>` | context bytes by hash, through the challenge window |

A `proofHash`, when one appears, is a hash only. It means something alongside availability, bonds and challenges, never by itself.

## Repository layout

```
packages/node/            mempool, jury coordination, sealer rotation, block store (node:sqlite)
  src/node.js             ChainNode: submit, prepareBlock, sealNext, accept, handleGossip
  src/verify.js           verifyBlock: every rule above, in order
  src/jury.js             replay jurors for core's rule(); HTTP and in-process juror clients
  src/store.js            SQLite schema with append-only triggers
  src/server.js           HTTP: gossip, storage, read API, explorer, submit, register
  bin/swarmchain-node.mjs start one node
packages/gossip/          commit, reveal, contract and block messages over HTTP
packages/storage/         availability layer: context by sha256 through the challenge window
packages/api/             the read API
packages/explorer/        a static page that reads the API
packages/bridge-solana/   milestone 5 stub: trigger message and quorum check
scripts/devnet.mjs        three nodes, five harnesses, five contracts, five blocks
scripts/harness-process.mjs  a core Harness served over HTTP; stand-in for the swarmHarness daemon
test/                     node:test suite
```

## Performance

Nothing here has run as a network. The devnet prints its own wall time, labeled measured: it is one machine, scripted answers and no model calls, so it measures the chain's message handling only, not a ruling's real latency, which is set by the slowest juror's model.

## License

MIT. Swarm Chain is a Verafy research project.
