/**
 * The node's HTTP face: gossip, storage, the read API, the explorer page, and
 * the few write routes a devnet needs (submit a contract, register a harness).
 * @module swarmchain/node/server
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Gossip } from '../../gossip/src/index.js'
import { readApi } from '../../api/src/index.js'
import { ChainNode } from './node.js'
import { httpJurorClient } from './jury.js'
import { queueMeta } from '#core'

const EXPLORER = fileURLToPath(new URL('../../explorer/index.html', import.meta.url))

/**
 * Start a node over HTTP.
 * @param {{id: string, port: number, host?: string, peers?: string[], db?: string, windowMs?: number, sealEveryMs?: number, log?: (e: object) => void}} options - node setup.
 * @returns {Promise<{node: ChainNode, server: import('node:http').Server, url: string, connect: () => Promise<void>, close: () => Promise<void>}>} the running node.
 */
export async function startNode({ id, port, host = '127.0.0.1', peers = [], db, windowMs, sealEveryMs = 200, log = () => {} }) {
  const url = `http://${host}:${port}`
  const node = new ChainNode({ id, url, db, windowMs, jurors: httpJurorClient(), log })
  const gossip = new Gossip({ self: url, peers, deliver: (type, msg) => node.handleGossip(type, msg) })
  node.gossip = gossip
  // Ask each peer for its decryption shares; each peer checks the draw itself.
  node.peers = {
    requestShares: draw => Promise.all(peers.filter(p => p !== url).map(async peer => {
      try {
        const res = await fetch(`${peer}/queue/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draw }), signal: AbortSignal.timeout(10_000) })
        const body = await res.json()
        return res.ok ? { peer, ok: true, shares: body.shares } : { peer, ok: false, error: body.error }
      } catch (err) {
        return { peer, ok: false, error: err.message }
      }
    })),
  }
  const api = readApi(node.store)

  async function handle(req) {
    if (req.method === 'GET' && req.path.length === 0) return { status: 200, html: await readFile(EXPLORER, 'utf8') }
    if (req.method === 'GET' && req.path[0] === 'health') return { status: 200, body: { id, height: node.tip()?.height ?? 0, tip: node.tip()?.hash ?? null, validators: [...node.validators.keys()], harnesses: node.store.harnesses().length } }
    if (req.method === 'GET' && req.path[0] === 'identity') return { status: 200, body: node.card }
    if (req.method === 'POST' && req.path[0] === 'contracts' && req.path.length === 1) {
      const h = await node.submit(req.body.asc)
      return { status: 201, body: { ascHash: h } }
    }
    // The encrypted queue, the quote and the chain config (read only: parameters change only by amendment).
    if (req.method === 'GET' && req.path[0] === 'config' && req.path.length === 1) return { status: 200, body: node.config }
    if (req.method === 'GET' && req.path[0] === 'queue' && req.path.length === 1) return { status: 200, body: { status: node.queueStatus(), entries: node.store.queue().map(({ id, meta, status, receivedAt, ascHash }) => ({ queueId: id, meta, status, receivedAt, ascHash })) } }
    if (req.method === 'GET' && req.path[0] === 'queue' && req.path[1] === 'committee') return { status: 200, body: node.committee() }
    if (req.method === 'POST' && req.path[0] === 'queue' && req.path.length === 1) return { status: 201, body: { queueId: await node.submitSealed(req.body.envelope) } }
    if (req.method === 'POST' && req.path[0] === 'queue' && req.path[1] === 'shares') return { status: 200, body: { shares: node.releaseShare(req.body.draw) } }
    if (req.method === 'POST' && req.path[0] === 'quote' && req.path.length === 1) {
      const meta = req.body.meta ?? queueMeta(req.body.asc, { escrowRef: req.body.escrowRef ?? 'quote' })
      return { status: 200, body: node.quote(meta) }
    }
    if (req.method === 'GET' && req.path[0] === 'costs' && req.path[1]) {
      const block = node.store.block(req.path[1])
      return block ? { status: 200, body: { height: block.height, split: node.costSplit(block) } } : { status: 404, body: { error: 'no such block' } }
    }
    if (req.method === 'POST' && req.path[0] === 'harnesses' && req.path.length === 1) {
      node.registerHarness(req.body)
      return { status: 201, body: { registered: req.body.card.id } }
    }
    return (await gossip.route(req)) ?? node.storage.route(req) ?? api(req) ?? { status: 404, body: { error: 'no such route' } }
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, url)
    let body = null
    try {
      const chunks = []
      for await (const ch of req) chunks.push(ch)
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const out = await handle({ method: req.method, path: u.pathname.split('/').filter(Boolean), query: u.searchParams, body })
      send(res, out)
    } catch (err) {
      send(res, { status: err.code && String(err.message).startsWith('block rejected') ? 422 : 400, body: { error: err.message, code: err.code } })
    }
  })
  await new Promise(r => server.listen(port, host, r))

  // Learn every peer's key, then take part in the sealer rotation.
  async function connect() {
    for (const p of peers.filter(p => p !== url)) {
      for (let i = 0; ; i++) {
        try {
          const card = await (await fetch(`${p}/identity`)).json()
          node.addValidator(card)
          break
        } catch (err) {
          if (i > 100) throw new Error(`peer ${p} unreachable: ${err.message}`)
          await new Promise(r => setTimeout(r, 100))
        }
      }
    }
    // Seal only once the whole rotation is known.
    timer = setTimeout(tick, sealEveryMs)
  }

  let timer = null
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try { await node.sealNext() } catch (err) { log({ event: 'seal-failed', node: id, error: err.message }) }
    if (!stopped) timer = setTimeout(tick, sealEveryMs)
  }

  return {
    node, server, url, connect,
    close: async () => { stopped = true; clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)) },
  }
}

function send(res, { status, body, html }) {
  res.setHeader('access-control-allow-origin', '*')
  if (html !== undefined) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
