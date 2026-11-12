/**
 * Finds transcript files, reads only what was appended since the last read,
 * and keeps a Session per main transcript.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { type AdvisorCall, type Alert, COMPACT_AT, type LogEvent, type Overview, type SessionLink, type SessionSummary, type Settings, type Usage, contextWindow } from '../shared/types.ts'
import { type RegistryEntry, type ResolvedLinks, readRegistry, resolveLinks } from './links.ts'
import { Session, type SubagentMeta, type Transcript, clip, dayOf } from './reader.ts'
import { type SpendEvent, hash, spendAlerts, usageOf } from './usage.ts'

/** Alerts only for sessions active this recently: older ones are history, not news. */
const ALERT_RECENT_MS = 30 * 60_000
/** A context this full gets an alert. */
export const CONTEXT_ALERT = 0.8
/** A running subagent quiet this long gets an alert. */
export const STALL_MS = 10 * 60_000

const NEWLINE = 0x0a
/** A single read never takes more than this; the rest is read on the next pass. */
const MAX_CHUNK = 64 * 1024 * 1024

const projectOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? (cwd || 'unknown')

interface Tracked {
  file: string
  sessionId: string
  agentId?: string
  offset: number
  size: number
  mtimeMs: number
  rest: Buffer
}

export class Store {
  readonly sessions = new Map<string, Session>()
  private files = new Map<string, Tracked>()
  private busy = new Set<string>()
  version = 0
  scanStats = { files: 0, bytes: 0, ms: 0 }

  /** Running sessions, as Claude Code registers them next to the projects folder. */
  registry: RegistryEntry[] = []
  /** Your budgets; the server loads and saves them. */
  settings: Settings = { budgets: {} }
  /** When each budget alert first showed, for its time. */
  private alertSeen = new Map<string, number>()
  private resolved?: { version: number; registry: RegistryEntry[]; links: ResolvedLinks }

  constructor(
    readonly root: string,
    readonly windowDays: number,
    readonly registryDir = path.join(path.dirname(root), 'sessions'),
  ) {}

  /** Every session's exchanges with other sessions, with the other side named; cached until something changes. */
  links(): ResolvedLinks {
    if (this.resolved?.version === this.version && this.resolved.registry === this.registry) return this.resolved.links
    const now = Date.now()
    const sources = [...this.sessions.values()].map(s => ({ sessionId: s.id, title: s.summary(now).title, links: s.main.links }))
    const links = resolveLinks(sources, this.registry)
    this.resolved = { version: this.version, registry: this.registry, links }
    return links
  }

  /** A session's exchanges with other sessions, the other side named where known. */
  linksOf(sessionId: string): SessionLink[] {
    return this.links().bySession.get(sessionId) ?? []
  }

  private get cutoff() {
    return Date.now() - this.windowDays * 86_400_000
  }

  /** Find transcripts modified inside the window and read anything new. Returns true when something changed. */
  async scan(): Promise<boolean> {
    const started = Date.now()
    let changed = false
    let projects: string[] = []
    try {
      projects = await fs.readdir(this.root)
    } catch {
      return false
    }
    for (const project of projects) {
      const dir = path.join(this.root, project)
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          if (await this.touch(path.join(dir, entry.name), entry.name.slice(0, -6))) changed = true
        } else if (entry.isDirectory()) {
          const subDir = path.join(dir, entry.name, 'subagents')
          let subs: string[] = []
          try {
            subs = await fs.readdir(subDir)
          } catch {
            continue
          }
          for (const name of subs) {
            if (!name.endsWith('.jsonl')) continue
            const agentId = name.slice(0, -6).replace(/^agent-/, '')
            if (await this.touch(path.join(subDir, name), entry.name, agentId)) changed = true
          }
        }
      }
    }
    if (changed) this.version++
    this.scanStats = {
      files: this.files.size,
      bytes: [...this.files.values()].reduce((n, f) => n + f.offset, 0),
      ms: Date.now() - started,
    }
    return (await this.refreshRegistry()) || changed
  }

  /** Re-reads which sessions run and whether they wait on you. Returns true when that changed. */
  async refreshRegistry(): Promise<boolean> {
    const registry = await readRegistry(this.registryDir)
    if (JSON.stringify(registry) === JSON.stringify(this.registry)) return false
    this.registry = registry
    this.version++
    return true
  }

  /**
   * A session's summary with what its running process reports. What it waits on is shown only
   * while the session runs: a closed app or terminal can't be waiting on you.
   */
  summaryOf(session: Session, now = Date.now()): SessionSummary {
    const s = { ...session.summary(now), ...this.missedOf(session) }
    const reg = this.registry.find(r => r.sessionId === session.id)
    if (!reg) return { ...s, waiting: undefined }
    const runState = reg.status === 'busy' || reg.status === 'waiting' ? reg.status : 'idle'
    let waiting = s.waiting
    // An open dialog it reports beats what the transcript suggests, unless the transcript names the question.
    if (runState === 'waiting' && waiting?.kind !== 'question' && waiting?.kind !== 'plan') {
      waiting = { kind: 'dialog', text: reg.waitingFor ?? 'a dialog', blocked: true, at: reg.statusUpdatedAt ?? now }
    }
    // Working again: the question its last turn ended with is behind it.
    if (runState === 'busy' && waiting?.kind === 'asked') waiting = undefined
    return { ...s, runState, waiting }
  }

  /** Possible missed delegations inside the window, like the charts. */
  missedRunsOf(session: Session) {
    return session.main.missedRuns().filter(r => r.at >= this.cutoff)
  }

  private missedOf(session: Session): Pick<SessionSummary, 'missed' | 'missedCost'> {
    const runs = this.missedRunsOf(session)
    return { missed: runs.length, missedCost: runs.reduce((n, r) => n + r.cost, 0) }
  }

  /** Read a file that the watcher says changed. */
  async changed(file: string): Promise<boolean> {
    const tracked = this.files.get(file)
    if (tracked) {
      const did = await this.read(tracked)
      if (did) this.version++
      return did
    }
    return false
  }

  private async touch(file: string, sessionId: string, agentId?: string): Promise<boolean> {
    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(file)
    } catch {
      return false
    }
    let tracked = this.files.get(file)
    if (!tracked) {
      if (stat.mtimeMs < this.cutoff) return false
      tracked = { file, sessionId, agentId, offset: 0, size: 0, mtimeMs: 0, rest: Buffer.alloc(0) }
      this.files.set(file, tracked)
    }
    if (agentId) await this.readMeta(tracked)
    if (stat.size === tracked.offset && stat.mtimeMs === tracked.mtimeMs) return false
    return this.read(tracked)
  }

  private session(id: string): Session {
    let s = this.sessions.get(id)
    if (!s) {
      s = new Session(id)
      this.sessions.set(id, s)
    }
    return s
  }

  private transcriptFor(t: Tracked, meta: SubagentMeta = {}): Transcript {
    const s = this.session(t.sessionId)
    return t.agentId ? s.agent(t.agentId, meta) : s.main
  }

  private async readMeta(t: Tracked) {
    const metaFile = t.file.replace(/\.jsonl$/, '.meta.json')
    try {
      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as SubagentMeta
      this.transcriptFor(t, meta)
    } catch {
      this.transcriptFor(t)
    }
  }

  /** Read from the stored offset to the end, splitting on newline bytes so characters and half-written lines survive. */
  private async read(t: Tracked): Promise<boolean> {
    if (this.busy.has(t.file)) return false
    this.busy.add(t.file)
    try {
      const stat = await fs.stat(t.file)
      if (stat.size < t.offset) {
        // The file was rewritten: forget what this file contributed and read it again.
        this.reset(t)
      }
      if (stat.size === t.offset) {
        t.mtimeMs = stat.mtimeMs
        return false
      }
      const handle = await fs.open(t.file, 'r')
      let read = 0
      try {
        const length = Math.min(stat.size - t.offset, MAX_CHUNK)
        const buf = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buf, 0, length, t.offset)
        read = bytesRead
        const data = t.rest.length ? Buffer.concat([t.rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
        const transcript = this.transcriptFor(t)
        let start = 0
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== NEWLINE) continue
          if (i > start) transcript.ingestLine(data.toString('utf8', start, i))
          start = i + 1
        }
        t.rest = Buffer.from(data.subarray(start))
      } finally {
        await handle.close()
      }
      t.offset += read
      t.size = stat.size
      t.mtimeMs = stat.mtimeMs
      // A big file is read in chunks: keep going until the end.
      if (t.offset < stat.size) {
        this.busy.delete(t.file)
        await this.read(t)
      }
      return true
    } catch {
      return false
    } finally {
      this.busy.delete(t.file)
    }
  }

  private reset(t: Tracked) {
    const s = this.session(t.sessionId)
    if (t.agentId) {
      const meta = s.agents.get(t.agentId)?.meta ?? {}
      s.agents.delete(t.agentId)
      s.agent(t.agentId, meta)
    } else {
      const fresh = new Session(t.sessionId)
      for (const [id, a] of s.agents) fresh.agents.set(id, a)
      this.sessions.set(t.sessionId, fresh)
    }
    t.offset = 0
    t.rest = Buffer.alloc(0)
  }

  trackedFile(file: string): boolean {
    return this.files.has(file)
  }

  overview(): Overview {
    const now = Date.now()
    // Long-running chats carry older history; the charts cover the window only.
    const firstDay = dayOf(this.cutoff)
    // A file touched recently can hold a chat whose last activity is older than the window.
    const live = [...this.sessions.values()].filter(s => (s.main.startedAt > 0 || s.agents.size > 0) && s.lastAt() >= this.cutoff)
    const sessions = live.map(s => this.summaryOf(s, now)).sort((a, b) => b.lastAt - a.lastAt)

    const daily = new Map<string, { output: number; total: number; cost: number }>()
    const heat = new Map<string, number>()
    const log: LogEvent[] = []
    const advisor: AdvisorCall[] = []
    const projects = new Map<string, { name: string; cost: number; sessions: number }>()
    for (const s of live) {
      let windowCost = 0
      for (const t of s.transcripts()) {
        for (const [key, v] of t.daily) {
          if (key < firstDay) continue
          const into = daily.get(key) ?? { output: 0, total: 0, cost: 0 }
          into.output += v.output
          into.total += v.total
          into.cost += v.cost
          windowCost += v.cost
          daily.set(key, into)
        }
        for (const [key, n] of t.hours) {
          const [day = '', slot = ''] = key.split('|')
          if (day < firstDay) continue
          heat.set(slot, (heat.get(slot) ?? 0) + n)
        }
      }
      log.push(...s.log().slice(-80))
      advisor.push(...s.advisorCalls().filter(a => a.at >= this.cutoff))
      const name = projectOf(s.main.cwd)
      const p = projects.get(name) ?? { name, cost: 0, sessions: 0 }
      p.cost += windowCost
      p.sessions++
      projects.set(name, p)
    }
    const usage = this.usage(now)
    return {
      generatedAt: now,
      windowDays: this.windowDays,
      sessions,
      daily: [...daily.entries()]
        .map(([key, v]) => {
          const [day = '', model = ''] = key.split('|')
          return { day, model, ...v }
        })
        .sort((a, b) => a.day.localeCompare(b.day)),
      heatmap: [...heat.entries()].map(([key, n]) => {
        const [d = '0', h = '0'] = key.split(':')
        return [Number(d), Number(h), n] as [number, number, number]
      }),
      log: log.sort((a, b) => a.at - b.at).slice(-300),
      advisor: advisor.sort((a, b) => b.at - a.at).slice(0, 50),
      advisorCount: advisor.length,
      ...this.talk(),
      scan: this.scanStats,
      projects: [...projects.values()].filter(p => p.cost > 0).sort((a, b) => b.cost - a.cost),
      usage,
      alerts: this.alerts(now, usage),
    }
  }

  /** Spend in the current 5-hour window, today and this week, from every transcript read. */
  usage(now = Date.now()): Usage {
    const events: SpendEvent[] = []
    for (const s of this.sessions.values()) for (const t of s.transcripts()) events.push(...t.spend)
    return usageOf(events, now, this.settings.budgets)
  }

  /**
   * What deserves a notification now: a context nearly full, the same tool error twice, a
   * subagent gone quiet, a budget nearly reached. Ids are stable, so the
   * desktop app notifies each once.
   */
  alerts(now = Date.now(), usage = this.usage(now)): Alert[] {
    const out: Alert[] = []
    for (const s of this.sessions.values()) {
      if (now - s.lastAt() > ALERT_RECENT_MS) continue
      const sum = this.summaryOf(s, now)
      const window = contextWindow(sum.mainModel)
      const share = sum.contextTokens / window
      if (share >= CONTEXT_ALERT) {
        out.push({
          id: `context:${s.id}:${s.main.contextDrops}`,
          kind: 'context',
          sessionId: s.id,
          title: `${sum.title}: context ${Math.round(100 * share)}% full`,
          text: `${Math.round(sum.contextTokens / 1000)}k of ${Math.round(window / 1000)}k tokens. Compact it or start a new session (Hivescope suggests compacting from ${Math.round(100 * COMPACT_AT)}%).`,
          at: s.main.lastAt,
        })
      }
      for (const t of s.transcripts()) {
        for (const [key, e] of t.errorRepeats) {
          if (e.count < 2 || now - e.lastAt > ALERT_RECENT_MS) continue
          const who = t.agentId ? `${t.who} subagent` : 'main session'
          out.push({
            id: `error:${s.id}:${t.agentId ?? 'main'}:${hash(key)}:${e.firstAt}`,
            kind: 'error',
            sessionId: s.id,
            title: `${sum.title}: same ${e.tool} error ${e.count}×`,
            text: `In the ${who}: ${clip(e.text, 160)}`,
            at: e.lastAt,
          })
        }
      }
      for (const run of s.subagents(now)) {
        const t = s.agents.get(run.id)?.transcript
        if (run.status !== 'running' || !t || now - t.lastAt < STALL_MS) continue
        out.push({
          id: `stalled:${s.id}:${run.id}:${t.lastAt}`,
          kind: 'stalled',
          sessionId: s.id,
          title: `${run.type} has been quiet for ${Math.round((now - t.lastAt) / 60_000)} min`,
          text: `${run.description || 'Subagent'} in ${sum.title}. It may be waiting on a long command, or stuck.`,
          at: t.lastAt,
        })
      }
    }
    for (const a of spendAlerts(usage, now)) {
      if (!this.alertSeen.has(a.id)) this.alertSeen.set(a.id, now)
      out.push({ ...a, at: this.alertSeen.get(a.id)! })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /** Who messaged whom in the window, and the newest messages. */
  private talk(): Pick<Overview, 'edges' | 'messages'> {
    const { bySession, edges } = this.links()
    const messages: Overview['messages'] = []
    const sent = new Set([...bySession.values()].flat().filter(l => l.kind === 'sent' && l.msgId).map(l => l.msgId))
    for (const [sessionId, links] of bySession) {
      for (const l of links) {
        if (l.at < this.cutoff || l.kind === 'forked') continue
        // Each message once: from its sender, or from its receiver when the sender's transcript isn't here.
        if (l.kind === 'received' && l.msgId && sent.has(l.msgId)) continue
        messages.push({ ...l, sessionId })
      }
    }
    return {
      edges: edges.filter(e => e.lastAt >= this.cutoff),
      messages: messages.sort((a, b) => b.at - a.at).slice(0, 40),
    }
  }
}
