# node

> Concept and prototype. Not a running network, no token, not audited.

A Swarm Chain node: a mempool of funded contracts, jury coordination, sealer rotation, and a block store on `node:sqlite`. It never calls a model.

- `src/node.js`: `ChainNode`. `submit` checks a contract and every context pin, `prepareBlock` runs one jury round and seals it, `sealNext` does that on this node's turn, `accept` verifies and appends, `handleGossip` takes peer messages.
- `src/verify.js`: `verifyBlock`, every design rule in order, each with a rejection code.
- `src/jury.js`: replay jurors that feed recorded commitments and reveals to core's `rule`, and juror clients over HTTP or in process.
- `src/store.js`: the SQLite schema. Blocks, rulings and reviews are append-only by trigger.
- `src/server.js`: the HTTP face. `bin/swarmchain-node.mjs` starts one node:

```sh
node packages/node/bin/swarmchain-node.mjs --id node-1 --port 7101 --peers http://127.0.0.1:7101,http://127.0.0.1:7102,http://127.0.0.1:7103
```

Write routes, for the devnet: `POST /contracts` (`{asc, challenge?}`) and `POST /harnesses` (a card signed by the harness's own key).
