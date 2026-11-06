# gossip

> Concept and prototype. Not a running network, no token, not audited.

Messages between nodes over HTTP: `contract` (a funded contract, as hashes), `commit` (a juror's signed commitment), `reveal` (its signed reveal) and `block`. Each envelope is identified by the SHA-256 of its message, seen messages are dropped, rejected messages are not relayed, and new ones are relayed to every peer.

Every node checks each `commit` signature against the registered key, and each `reveal` against the commitment it saw, so a juror cannot show one node one vote and another node another.

`LocalBus` has the same `broadcast` shape for in-process tests. libp2p comes later.
