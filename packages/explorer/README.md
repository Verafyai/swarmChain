# explorer

> Concept and prototype. Not a running network, no token, not audited.

One static page, `index.html`, that reads a node's API: blocks, rulings and harness records, refreshed every three seconds. Each node serves it at `/`. Opened as a file, it reads `http://127.0.0.1:7101`; pass `?api=<url>` to read another node.

```sh
npm run devnet -- --keep    # then open http://127.0.0.1:7101/
```
