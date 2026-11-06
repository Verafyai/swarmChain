# storage

> Concept and prototype. Not a running network, no token, not audited.

The availability layer. A block holds context as hashes; the bytes live here, served by SHA-256 at `GET /storage/<sha256>` for at least the challenge window (seven days by default). When a ruling is sealed, every context hash it read is retained for a window from the block's time.

Content is hashed by core on the way in and again on the way out, so a node never stores or serves bytes that do not match their pin. `fetchContext` pulls bytes from other nodes and checks the hash before trusting them.

Not yet: storage harnesses as a separate role, paid from `split.storage` and bonded against a file that cannot be produced.
