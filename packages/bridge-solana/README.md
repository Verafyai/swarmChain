# bridge-solana

> Concept and prototype. Not a running network, no token, not audited.

Milestone 5. A stub.

A sealed ruling can carry a `call` trigger, such as `market.settle(NO)` on Solana. A trigger may leave the chain only with signatures from at least the contract's quorum of the jurors whose votes were counted. This package defines that message (`triggerMessage`, kind `swarmchain.trigger/0`) and the check (`hasQuorum`, signatures verified with core). `relay` refuses everything: no Solana program exists yet.

To build in milestone 5, against the draft SIMDs (Inference Programs; Evaluators and Attestations; Rulings, Disputes and Challenges):

- a devnet program that accepts a quorum-signed trigger and checks each Ed25519 signature with the precompile;
- the relay: watch sealed blocks, collect juror signatures over each trigger, submit the transaction;
- a devnet prediction market created, funded, resolved by a jury and settled by a quorum-signed call.

The trigger message format belongs in `@verafyharness/core`; it lives here only until core has one.
