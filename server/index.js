import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mock from './mock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const PORT = Number(process.env.PORT || 8791)

const env = {
  provider: process.env.UNS_PROVIDER || 'mock',
  supos: {
    apiUrl: process.env.SUPOS_API_URL || '',
    apiKey: process.env.SUPOS_API_KEY || '',
  },
  umh: {
    brokers: (process.env.UMH_BROKERS || '').split(',').filter(Boolean),
    schemaRegistryUrl: process.env.UMH_SCHEMA_REGISTRY || '',
  },
}

let suposAdapter = null
let umhAdapter = null

async function getAdapter(provider) {
  if (provider === 'supos') {
    if (!env.supos.apiUrl) throw new Error('SUPOS_API_URL 未配置')
    if (!suposAdapter) {
      const mod = await import('dsh-uns/lib/supos.js')
      suposAdapter = new mod.SuposAdapter({
        apiUrl: env.supos.apiUrl,
        apiKey: env.supos.apiKey,
        timeoutMs: 15000,
        writeField: 'value',
      })
    }
    return { adapter: suposAdapter, kind: 'supos' }
  }
  if (provider === 'umh') {
    if (!env.umh.brokers.length) throw new Error('UMH_BROKERS 未配置')
    if (!umhAdapter) {
      const mod = await import('dsh-uns/lib/umh.js')
      umhAdapter = new mod.UmhAdapter({
        brokers: env.umh.brokers,
        schemaRegistryUrl: env.umh.schemaRegistryUrl,
        clientId: 'dsh-uns-dashboard',
        requestTimeoutMs: 10000,
      })
    }
    return { adapter: umhAdapter, kind: 'umh' }
  }
  return null
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function resolveProvider(url) {
  const requested = url.searchParams.get('provider') || env.provider
  const remote = await getAdapter(requested)
  if (!remote) return { name: 'mock' }
  return { name: requested, ...remote }
}

async function handleTree(res, providerInfo) {
  if (!providerInfo.adapter) return json(res, 200, mock.mockTree())
  const nodes = await providerInfo.adapter.browseTree(5, 600)
  return json(res, 200, nodes)
}

async function handleRead(res, providerInfo, url) {
  const paths = (url.searchParams.get('paths') || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!paths.length) return json(res, 400, { error: 'paths 参数为空' })
  if (!providerInfo.adapter) return json(res, 200, mock.mockRead(paths))
  const points = await providerInfo.adapter.read(paths)
  return json(res, 200, points)
}

async function handleHistory(res, providerInfo, url) {
  const p = url.searchParams
  const target = p.get('path')
  if (!target) return json(res, 400, { error: 'path 参数为空' })
  const startMs = Number(p.get('startMs')) || Date.now() - 3600000
  const endMs = Number(p.get('endMs')) || Date.now()
  const limit = Math.min(Number(p.get('limit')) || 600, 1000)
  if (!providerInfo.adapter) return json(res, 200, mock.mockHistory(target, startMs, endMs, limit))
  const points = await providerInfo.adapter.history(target, startMs, endMs, limit)
  return json(res, 200, points)
}

async function handleWrite(req, res, providerInfo) {
  const body = await readBody(req)
  const entries = Array.isArray(body.writes) ? body.writes : []
  if (!entries.length) return json(res, 400, { error: 'writes 数组为空' })
  if (!providerInfo.adapter) {
    const written = mock.mockWrite(entries)
    return json(res, 200, { written })
  }
  const written = await providerInfo.adapter.writeMany(entries)
  return json(res, 200, { written })
}

function handleStream(res, providerInfo, url) {
  const topics = (url.searchParams.get('topics') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const controller = new AbortController()
  req_aborted(controller, res)

  const send = (point) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(point)}\n\n`)
  }

  if (!providerInfo.adapter) {
    mock.createMockStream(topics, send, controller.signal)
    return
  }

  const chainWatch = async () => {
    while (!controller.signal.aborted && !res.writableEnded) {
      try {
        const points = await providerInfo.adapter.watch(topics, 2000, 400)
        points.forEach(send)
      } catch (error) {
        send({ path: '__error__', value: String(error.message || error), timestampMs: Date.now() })
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
  }
  chainWatch()
}

function req_aborted(controller, res) {
  res.on('close', () => controller.abort())
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.join(PUBLIC_DIR, relative)
  if (!target.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' })
  try {
    const content = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
    res.end(content)
  } catch {
    json(res, 404, { error: `未找到 ${pathname}` })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname)
    const providerInfo = await resolveProvider(url)
    if (url.pathname === '/api/config') {
      return json(res, 200, { active: providerInfo.name, configured: { supos: Boolean(env.supos.apiUrl), umh: env.umh.brokers.length > 0 } })
    }
    if (url.pathname === '/api/tree') return await handleTree(res, providerInfo)
    if (url.pathname === '/api/read') return await handleRead(res, providerInfo, url)
    if (url.pathname === '/api/history') return await handleHistory(res, providerInfo, url)
    if (url.pathname === '/api/write' && req.method === 'POST') return await handleWrite(req, res, providerInfo)
    if (url.pathname === '/api/stream') return handleStream(res, providerInfo, url)
    return json(res, 404, { error: `未知端点 ${url.pathname}` })
  } catch (error) {
    return json(res, 502, { error: String(error.message || error) })
  }
})

server.listen(PORT, () => {
  console.log(`[dsh-uns-dashboard] http://localhost:${PORT} (provider=${env.provider})`)
})
