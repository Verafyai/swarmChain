# Batching and the encrypted queue

Status: prototype on the devnet. Built and tested in `packages/node/src/batch.js`, `packages/node/src/node.js` and `test/batching.test.js`, with the queue crypto in verafyHarness core (`packages/core/src/queue.js`). Concept and prototype: nothing here is live, there is no token, and nothing is audited. Every number below is modeled with verafyHarness `packages/economics` (L2, FlashProve, unpacked preset, defaults dated 2026-11-06) unless it says otherwise.

## When a block closes

An **L1** contract does not batch. It seals in a block of its own as soon as a jury rules, as before.

An **L2** contract (`payment.jury.assurance` of `L2` or `L3`) carries a proof of inference per vote, so it waits in the queue. One proof is cheap, about $0.0103 of GPU time (modeled). A small block is uneconomic because of fixed cost: warm-up ($5.00 for five provers, modeled from 15 illustrative minutes at $4.00 per GPU hour) and idle GPU hours. So a block of L2 contracts closes when either rule holds:

1. **Value.** The fixed cost (warm-up plus the idle reserve) is at most `warmupMaxPct` of the block's modeled cost, and the funded escrow in the queue covers the block's cost plus the margin (30%, the economics default). For 800-token contracts with five jurors, the warm-up rule holds from 432 contracts, which is `minRequestsForWarmup` in `packages/economics` (tested).
2. **Time.** A queued contract has waited its maximum: its own `maxWaitSeconds`, or the chain default.

**Contracts can lean either way** (fields in verafyHarness core, both optional, so a contract without them keeps its hash):

- `payment.minBatch`: never seal in a block with fewer contracts than this. It holds even when the time rule fires; the contract keeps waiting. Every node rejects a block that holds a contract with fewer rulings than its `minBatch` (`batch-min`).
- `payment.maxWaitSeconds`: seal no later than this. A contract that seals early in a small block pays a larger share of the fixed cost.

Every node also rejects a block that batches an L1 contract with others (`batch`).

### Defaults (illustrative; Rex must confirm)

They live in `config/chain.json`, are frozen when a node loads them, and change only by amendment (`AMENDMENTS.md`). No API route changes them. They go in the ratification contract for Block 0.

| Parameter | Value | Label |
|---|---|---|
| L1 batching | none: seal as soon as a jury rules | illustrative, proposed |
| L2 value rule: fixed cost at most | 10% of the block's modeled cost | illustrative, proposed |
| L2 `maxWaitSeconds` | 3,600 s | illustrative, proposed |
| L2 idle reserve per block | $0 until a proving operator measures idle time (Part D) | illustrative |
| Currencies counted toward funding | USDC and USDT at $1 | illustrative |
| Shares needed to open a queued contract | a majority of the node set (2 of 3 on the devnet) | illustrative |
| Clock skew a node allows on the time rule | 60 s | illustrative |

## Who pays what

The block's modeled cost is split **pro rata by proven requests**: a contract's requests (`ceil(tokens / 1,024)`, from `estimate()`) times its jury size. Shares are whole micro-dollars, assigned by largest remainder, so they sum exactly to the block cost (tested). For 24 contracts of 800 tokens the block costs $7.50 and each share is $0.3127 (modeled, the `packages/economics` test vector).

**The quote, before funding.** `POST /quote` on any node, with `{ asc }` or `{ meta }`, or offline:

```
npm run quote -- path/to/contract.json [--tokens 800]
```

It returns the contract's proven requests, its share if the block closed with the queue as it stands, its share at the size where the value rule closes the block, its share alone (if the time rule seals it by itself), and whether its escrow covers that worst case. Everything in it is labeled modeled. `GET /costs/<height>` gives the split for a sealed block.

In this prototype the split is computed and shown, and nothing pays provers yet. Paying the proving operator out of the split is Part D.

## The encrypted queue

**Why.** Before a jury is drawn, nobody should be able to read a queued contract. That stops front-running, pre-bribing likely jurors, and copying a question into a competing market.

**Submission.** The author fetches the node set (`GET /queue/committee`), seals the contract with core's `sealContract`, and posts the envelope (`POST /queue`). The contract is encrypted under a fresh AES-256-GCM key; the key is split t of n with Shamir's scheme over GF(2^521 - 1), and each node's share is encrypted to that node's X25519 key. Only the escrow reference and the payment metadata needed to check funding, draw a jury and close a block travel in the clear: escrow amount, currency, chain, escrow reference, jury rules, `minBatch`, `maxWaitSeconds` and the declared size in tokens. They are bound to the ciphertext as associated data and checked against the plaintext when it opens; a declared size below the contract's own is refused. The contract hash is not in the clear, so a guessable contract cannot be confirmed by hashing guesses.

**Release.** When a close rule holds, the sealer draws every jury from the parent block hash and signs the draw. Each node checks the draw on its own view before it releases its share: signed by the node whose turn it is, seeded by its own tip, every jury the draw that seed gives, and a close rule that holds on its own clock and queue. Otherwise it withholds its share. With t shares the sealer opens the contracts and gossips their keys with the draw; every node checks the draw again and opens them itself.

**Reveal.** At reveal the plaintext and its pins go to the availability layer on every node, kept through the challenge window. Then the juries run, and the block seals. The drawn jurors read the contract only after the draw (tested).

### What it does not hide

- **The prover sees the plaintext.** A proving machine sees the contract it proves. Encryption protects the queue, not the prover.
- **Escrow amounts stay public on the source chain.** The escrow never leaves its source chain, where the amount is public unless that chain supports confidential amounts. The queue does not hide funds and does not claim to.
- **Solana confidential transfers are optional, and only where the cluster enables them.** Token-2022's confidential transfer extension can hide amounts and balances (addresses stay visible). It depends on the ZK ElGamal proof program, which Solana disabled on mainnet and devnet in June 2025 after a proof-forgery bug ([post-mortem](https://solana.com/news/post-mortem-june-25-2025)). Secondary reports from June 2026 say it was re-enabled; another from August 2026 says it was not yet. We could not confirm the current state from a primary source on 2026-11-06. Check the feature gate on the cluster you target before relying on it. Support for it here is planned, not built.
- **The declared size and the jury rules are visible.** They are what the nodes need to close a block and draw a jury.

### Prototype limits

- **No distributed key generation.** The author deals the shares for its own contract (it knows the plaintext anyway). A standing node-set key from real DKG is planned (ROADMAP.md).
- **No verifiable shares.** A bad share is caught only when the AES-GCM tag fails. Verifiable secret sharing is planned.
- **The close rule is checked when shares are released, not in block verification.** Arrival times are each node's own, so `verify.js` checks only what the block itself shows (`minBatch` and L1-alone). A majority of nodes must agree a rule holds before anything opens.
- **Queue keys live in memory.** A restarted node gets a new X25519 key; contracts sealed to its old key need the other nodes' shares.
- **L2 votes on the devnet carry no proofs yet.** The harnesses answer from the scripted provider. Proving is Part D.
