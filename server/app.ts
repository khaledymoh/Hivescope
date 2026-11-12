/**
 * The Hivescope server as a function, so the command line and the desktop app
 * start the same thing.
 *
 * It listens on 127.0.0.1 only and refuses requests whose Host header is not
 * this machine, because it exposes every Claude Code chat on this PC.
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { type IncomingMessage, createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { cleanSettings, loadSettings, saveSettings, settingsPath } from './settings.ts'
import { type OpenedCheck, type ShotRoots, type Trash, deleteShots, listOpened, listShots, resolveShot, summarize } from './shots.ts'
import { type SessionInfo, freeSpace, spaceReport } from './space.ts'
import { Store } from './store.ts'
import type { LeftoverKind } from '../shared/types.ts'

const SHOT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface HivescopeOptions {
  /** 0 picks any free port. */
  port: number
  days: number
  /** The folder Claude Code writes transcripts to (`~/.claude/projects`). */
  root: string
  /** The built page. */
  dist: string
  /** Where Claude Code keeps per-session temporary files; defaults to <temp>/claude. */
  tempRoot?: string
  /**
   * Moves a file to the Recycle Bin / Trash. The desktop app passes Electron's; without it,
   * images Claude opened from your own folders can't be removed from Hivescope.
   */
  trash?: Trash
  log?: (message: string) => void
}

export interface Hivescope {
  port: number
  url: string
  store: Store
  /** Called after every change the page is told about. */
  onChange(listener: () => void): void
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function startHivescope(opts: HivescopeOptions): Promise<Hivescope> {
  const log = opts.log ?? (() => {})
  const dist = path.resolve(opts.dist)
  const store = new Store(opts.root, opts.days)
  const clients = new Set<ServerResponse>()
  const listeners = new Set<() => void>()
  // Filled in once the port is known; the Vite dev page on 5317 is allowed too.
  const allowedHosts = new Set(['127.0.0.1:5317', 'localhost:5317'])

  function broadcast() {
    const payload = `event: update\ndata: ${store.version}\n\n`
    for (const res of clients) res.write(payload)
    for (const listener of listeners) listener()
  }

  // Several writes land at once: batch them, at most one push every 750 ms.
  const pending = new Set<string>()
  let flushTimer: NodeJS.Timeout | undefined
  function queue(file: string) {
    pending.add(file)
    flushTimer ??= setTimeout(async () => {
      flushTimer = undefined
      const files = [...pending]
      pending.clear()
      let changed = false
      let unknown = false
      for (const f of files) {
        if (store.trackedFile(f)) changed = (await store.changed(f)) || changed
        else unknown = true
      }
      if (unknown) changed = (await store.scan()) || changed
      if (changed) broadcast()
    }, 750)
  }

  const shotRoots: ShotRoots = { projects: opts.root, temp: opts.tempRoot ?? path.join(os.tmpdir(), 'claude') }
  /** Title, project and live state per session, for naming screenshot folders. */
  const sessionInfo = () => {
    const now = Date.now()
    const map = new Map<string, SessionInfo>()
    for (const s of store.sessions.values()) {
      const sum = s.summary(now)
      map.set(s.id, { title: sum.title, projectName: sum.projectName, live: sum.status === 'live', lastAt: sum.lastAt })
    }
    return map
  }

  // Budgets live next to Claude Code's settings, in ~/.claude/hivescope.
  const settingsFile = settingsPath(path.dirname(opts.root))
  store.settings = await loadSettings(settingsFile)

  const wasOpened: OpenedCheck =(sessionId, file) => store.sessions.get(sessionId)?.imagesOpened().has(file) ?? false

  const server = createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(403).end('Hivescope only answers on this computer.')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/api/overview') return json(res, store.overview())

    // Budgets.
    if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, store.settings)
    if (url.pathname === '/api/settings') {
      // A custom header no other site can send without a CORS preflight this server never grants.
      if (req.method !== 'POST' || req.headers['x-hivescope'] !== 'change') return json(res, { error: 'refused' }, 403)
      let body: unknown
      try {
        body = JSON.parse(await readBody(req, 10_000))
      } catch {
        return json(res, { error: 'bad request' }, 400)
      }
      store.settings = cleanSettings(body)
      await saveSettings(settingsFile, store.settings)
      store.version++
      broadcast()
      return json(res, store.settings)
    }

    // Free space: what agents left behind, and freeing it.
    if (url.pathname === '/api/space' && req.method === 'GET') return json(res, await spaceReport(shotRoots, sessionInfo()))
    if (url.pathname === '/api/space/free') {
      // A custom header no other site can send without a CORS preflight this server never grants.
      if (req.method !== 'POST' || req.headers['x-hivescope'] !== 'delete') return json(res, { error: 'refused' }, 403)
      let body: { kinds?: unknown; sessionId?: unknown }
      try {
        body = JSON.parse(await readBody(req, 10_000)) as typeof body
      } catch {
        return json(res, { error: 'bad request' }, 400)
      }
      const kinds = Array.isArray(body.kinds) ? (body.kinds.filter(k => typeof k === 'string') as LeftoverKind[]) : []
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      const result = await freeSpace(shotRoots, sessionInfo(), { kinds, sessionId })
      log(`Hivescope: freed ${result.deleted} agent files (${(result.bytes / 1e6).toFixed(1)} MB), kept ${result.held} in active sessions`)
      return json(res, result)
    }

    // Screenshots: list, view, delete.
    if (url.pathname === '/api/shots' && req.method === 'GET') {
      const files = await listShots(shotRoots)
      const sessions = summarize(files, sessionInfo())
      const total = { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }
      return json(res, { sessions, total })
    }
    const shotsOf = url.pathname.match(/^\/api\/shots\/([\w-]+)$/)
    if (shotsOf && req.method === 'GET' && shotsOf[1] !== 'delete') {
      const own = (await listShots(shotRoots)).filter(f => f.sessionId === shotsOf[1])
      const session = store.sessions.get(shotsOf[1]!)
      const opened = session ? await listOpened(shotRoots, session.id, session.imagesOpened()) : []
      // Tells the page whether images opened from your folders can go to the Recycle Bin from here.
      res.setHeader('x-hivescope-trash', opts.trash ? '1' : '0')
      return json(res, [...own, ...opened])
    }
    const shot = url.pathname.match(/^\/api\/shot\/([\w-]+)$/)
    if (shot && req.method === 'GET') {
      const hit = resolveShot(shotRoots, shot[1]!, wasOpened)
      if (!hit) return json(res, { error: 'not found' }, 404)
      try {
        const body = await readFile(hit.file)
        res.writeHead(200, { 'content-type': SHOT_MIME[path.extname(hit.file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'private, max-age=300' })
        return res.end(body)
      } catch {
        return json(res, { error: 'not found' }, 404)
      }
    }
    if (url.pathname === '/api/shots/delete') {
      // A custom header no other site can send without a CORS preflight this server never grants.
      if (req.method !== 'POST' || req.headers['x-hivescope'] !== 'delete') return json(res, { error: 'refused' }, 403)
      let body: { ids?: string[]; sessionId?: string; all?: boolean; includePasted?: boolean; includeOpened?: boolean }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, { error: 'bad request' }, 400)
      }
      const allowPasted = body.includePasted === true
      // Opened images only when asked for by name, and only to the Recycle Bin.
      const allowOpened = body.includeOpened === true && opts.trash ? { check: wasOpened, trash: opts.trash } : undefined
      let ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : []
      if (body.sessionId || body.all) {
        const live = new Set([...sessionInfo()].filter(([, v]) => v.live).map(([k]) => k))
        ids = (await listShots(shotRoots))
          .filter(f => (body.all ? !live.has(f.sessionId) : f.sessionId === body.sessionId))
          .filter(f => allowPasted || f.kind !== 'pasted')
          .map(f => f.id)
      }
      const result = await deleteShots(shotRoots, ids, { pasted: allowPasted, opened: allowOpened })
      log(`Hivescope: deleted ${result.deleted} screenshots (${(result.bytes / 1e6).toFixed(1)} MB), ${result.trashed} of them to the Recycle Bin`)
      return json(res, result)
    }

    const agentMatch = url.pathname.match(/^\/api\/session\/([\w-]+)\/agent\/([\w-]+)$/)
    if (agentMatch) {
      const log = store.sessions.get(agentMatch[1]!)?.agentLog(agentMatch[2]!)
      return log ? json(res, log) : json(res, { error: 'not found' }, 404)
    }

    const match = url.pathname.match(/^\/api\/session\/([\w-]+)$/)
    if (match) {
      const session = store.sessions.get(match[1]!)
      return session
        ? json(res, { ...session.detail(Date.now()), ...store.summaryOf(session), links: store.linksOf(session.id), missedRuns: store.missedRunsOf(session) })
        : json(res, { error: 'not found' }, 404)
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`event: update\ndata: ${store.version}\n\n`)
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }

    // The built page.
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = path.resolve(dist, rel)
    if (!file.startsWith(dist)) {
      res.writeHead(400).end()
      return
    }
    try {
      const target = (await stat(file)).isFile() ? file : path.join(dist, 'index.html')
      // The page itself is never cached, so a rebuild shows up on reload; its assets have hashed names.
      const cache = target.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': cache })
      res.end(await readFile(target))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Page not built yet: run npm run build.')
    }
  })

  // Listen first, so a taken port fails fast before the slow first scan.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  allowedHosts.add(`127.0.0.1:${port}`)
  allowedHosts.add(`localhost:${port}`)

  log(`Hivescope: reading the last ${opts.days} days of ${opts.root}…`)
  await store.scan()
  const s = store.scanStats
  log(`Hivescope: ${store.sessions.size} sessions from ${s.files} files (${(s.bytes / 1e6).toFixed(0)} MB) in ${(s.ms / 1000).toFixed(1)} s`)
  // A page opened during the first scan saw part of it: tell it the rest is in.
  broadcast()

  let watcher: FSWatcher | undefined
  try {
    watcher = watch(opts.root, { recursive: true }, (_event, name) => {
      if (name && name.toString().endsWith('.jsonl')) queue(path.join(opts.root, name.toString()))
    })
  } catch (err) {
    log(`Hivescope: live file watching is unavailable, falling back to polling only. ${String(err)}`)
  }
  // A safety net for missed watch events and new folders. Pages also get a slow tick
  // when nothing changed, so "live", "recent" and "idle" age on their own.
  let lastPush = Date.now()
  const poll = setInterval(async () => {
    const changed = await store.scan()
    if (changed ||Date.now() - lastPush > 30_000) {
      broadcast()
      lastPush = Date.now()
    }
  }, 5_000)
  // Whether a session waits on you shows within a couple of seconds: only the small registry files are read.
  const waits = setInterval(async () => {
    if (await store.refreshRegistry()) broadcast()
  }, 2_000)

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    store,
    onChange: listener => void listeners.add(listener),
    close: async () => {
      clearInterval(poll)
      clearInterval(waits)
      watcher?.close()
      for (const res of clients) res.end()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
