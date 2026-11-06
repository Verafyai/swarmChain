# bridge-solana

> Concept and prototype. Not a running network, no token, not audited.

Milestone 5. A stub.

A sealed ruling can carry a `call` trigger, such as `market.settle(NO)` on Solana. A trigger may leave the chain only with signatures from at least the contract's quorum of the jurors whose votes were counted. The message and the quorum check are core's: `triggerMessage`, `signTrigger` and `verifyTrigger` from `@verafyharness/core`, kind `swarm.trigger/0`, with `ruling` set to core's `rulingId` and the contract's `ascHash`. This package re-exports them and adds `checkTrigger(store, message, signatures)`: the ruling is sealed in the block the message names, its contract is known, no review has overturned or superseded it, and core's `verifyTrigger` finds a quorum of counted jurors' signatures against their registered keys. `relay` refuses everything: no Solana program exists yet.

To build in milestone 5, against the draft SIMDs (Inference Programs; Evaluators and Attestations; Rulings, Disputes and Challenges):

- a devnet program that accepts a quorum-signed trigger and checks each Ed25519 signature with the precompile;
- the relay: watch sealed blocks, collect juror signatures over each trigger, submit the transaction;
- a devnet prediction market created, funded, resolved by a jury and settled by a quorum-signed call.
