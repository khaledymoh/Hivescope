/**
 * Which session is on the other end of each message between Claude sessions.
 *
 * Both sides of a message record the same msg_id: the sender in its SendMessage result,
 * the receiver in the message's origin. That join is exact, and it also teaches which
 * desktop id (`local_…`) and message address belong to which transcript. Messages with no
 * match on the other side (the other transcript is older than the window, or gone) fall
 * back to the running sessions' registry (~/.claude/sessions/*.json), then to a title that
 * only one session has.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SessionEdge, SessionLink } from '../shared/types.ts'

/** One running session, as Claude Code registers it in ~/.claude/sessions/<pid>.json. */
export interface RegistryEntry {
  sessionId: string
  hostSessionId?: string
  messagingSocketPath?: string
  name?: string
  /** busy, idle, or waiting (on you). */
  status?: string
  /** What it waits on: "input needed", a dialog's name, "worker request"… */
  waitingFor?: string
  statusUpdatedAt?: number
}

/** Whether a process still runs; a closed session can leave its file behind. */
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number') return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it runs, under another account.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readRegistry(dir: string): Promise<RegistryEntry[]> {
  let names: string[] = []
  try {
    names = (await fs.readdir(dir)).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: RegistryEntry[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Record<string, unknown>
      if (typeof raw.sessionId !== 'string' || !alive(raw.pid)) continue
      const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
      out.push({
        sessionId: raw.sessionId,
        hostSessionId: s(raw.hostSessionId),
        messagingSocketPath: s(raw.messagingSocketPath),
        name: s(raw.name),
        status: s(raw.status),
        waitingFor: s(raw.waitingFor),
        statusUpdatedAt: typeof raw.statusUpdatedAt === 'number' ? raw.statusUpdatedAt : undefined,
      })
    } catch {
      // Being rewritten, or not one of these files.
    }
  }
  return out
}

/** A message address as SendMessage writes it (`uds:\\.\pipe\…`) and as the registry does (`\\.\pipe\…`). */
const address = (a: string) => a.replace(/^uds:/, '').toLowerCase()

export interface LinkSource {
  sessionId: string
  title: string
  links: SessionLink[]
}

export interface ResolvedLinks {
  bySession: Map<string, SessionLink[]>
  edges: SessionEdge[]
}

export function resolveLinks(sources: LinkSource[], registry: RegistryEntry[] = []): ResolvedLinks {
  const title = new Map(sources.map(s => [s.sessionId, s.title]))
  const byLocal = new Map<string, string>()
  const byAddress = new Map<string, string>()
  for (const r of registry) {
    if (r.hostSessionId) byLocal.set(r.hostSessionId, r.sessionId)
    if (r.messagingSocketPath) byAddress.set(address(r.messagingSocketPath), r.sessionId)
  }

  // msg_id -> the sessions that sent and received it.
  const sentBy = new Map<string, string>()
  const receivedBy = new Map<string, string>()
  /** The sender's one-line summary, which the receiving side doesn't get. */
  const summaries = new Map<string, string>()
  for (const s of sources) {
    for (const l of s.links) {
      if (!l.msgId) continue
      if (l.kind === 'sent' && l.summary) summaries.set(l.msgId, l.summary)
      if (l.kind === 'sent') sentBy.set(l.msgId, s.sessionId)
      if (l.kind === 'received') receivedBy.set(l.msgId, s.sessionId)
    }
  }
  // A received message names its sender's desktop id and address: learn them from the matched pairs.
  for (const s of sources) {
    for (const l of s.links) {
      if (l.kind !== 'received' || !l.msgId) continue
      const sender = sentBy.get(l.msgId)
      if (!sender) continue
      if (l.peerLocal && !byLocal.has(l.peerLocal)) byLocal.set(l.peerLocal, sender)
      if (l.peerAddress && !byAddress.has(address(l.peerAddress))) byAddress.set(address(l.peerAddress), sender)
    }
  }
  // Titles only count when exactly one session has that title.
  const byTitle = new Map<string, string | null>()
  for (const s of sources) {
    const key = s.title.trim().toLowerCase()
    if (key) byTitle.set(key, byTitle.has(key) ? null : s.sessionId)
  }
  for (const r of registry) {
    const key = r.name?.trim().toLowerCase()
    if (key && !byTitle.has(key)) byTitle.set(key, r.sessionId)
  }

  const bySession = new Map<string, SessionLink[]>()
  const edges = new Map<string, SessionEdge>()
  for (const s of sources) {
    const out: SessionLink[] = []
    for (const l of s.links) {
      let peer: string | undefined
      if (l.msgId) peer = l.kind === 'sent' ? receivedBy.get(l.msgId) : sentBy.get(l.msgId)
      peer ??= (l.peerLocal && byLocal.get(l.peerLocal)) || (l.peerAddress && byAddress.get(address(l.peerAddress))) || undefined
      peer ??= (l.peerName && byTitle.get(l.peerName.trim().toLowerCase())) || undefined
      if (peer === s.sessionId) peer = undefined
      const summary = l.summary ?? (l.msgId ? summaries.get(l.msgId) : undefined)
      out.push({ ...l, ...(summary ? { summary } : {}), ...(peer ? { peerSessionId: peer, peerTitle: title.get(peer) ?? l.peerName } : {}) })
      if (peer && l.ok !== false && (l.kind === 'sent' || l.kind === 'received')) {
        const [from, to] = l.kind === 'sent' ? [s.sessionId, peer] : [peer, s.sessionId]
        // Each message is seen from both sides: count it from the sender's side, or the receiver's when the sender's is missing.
        if (l.kind === 'received' && l.msgId && sentBy.has(l.msgId)) continue
        const key = `${from}>${to}`
        const e = edges.get(key) ?? { from, to, count: 0, lastAt: 0 }
        e.count++
        e.lastAt = Math.max(e.lastAt, l.at)
        edges.set(key, e)
      }
    }
    bySession.set(s.sessionId, out)
  }
  return { bySession, edges: [...edges.values()] }
}
