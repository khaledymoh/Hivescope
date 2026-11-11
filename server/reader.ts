/**
 * Turns Claude Code transcript lines into session state.
 *
 * The transcript format is internal to Claude Code and undocumented, so every
 * assumption about it lives in this file. Each record is read defensively:
 * an unknown or malformed record is skipped, never fatal.
 */
import type {
  AdvisorCall,
  LogEvent,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  SubagentRun,
  TaskList,
  TaskStatus,
  TokenBucket,
  SessionLink,
  Waiting,
} from '../shared/types.ts'

const LOG_CAP = 400
const LIVE_MS = 2 * 60_000
const RECENT_MS = 30 * 60_000

/** Record types that are large and carry nothing Hivescope shows; skipped before parsing. */
const SKIP_PREFIXES = [
  '{"type":"api-request',
  '{"type":"file-history',
  '{"type":"frame-link',
  '{"type":"artifact-',
  '{"type":"atis-latch',
  '{"type":"queue-operation',
  '{"type":"mode"',
  '{"type":"cost-state',
  '{"type":"tools-used',
]

export function shouldSkip(line: string): boolean {
  return SKIP_PREFIXES.some(p => line.startsWith(p))
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function clip(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

/** A short description of a tool call, from the arguments most tools carry. */
export function describeCall(tool: string, input: unknown): string {
  const args = isObj(input) ? input : {}
  // How a subagent returns its result to the lead.
  if (tool === 'SubagentHandback') return 'handed its result back to the lead'
  // The app's own task list and turn wrap-up.
  if (/update_plan$|^TodoWrite$/.test(tool)) return 'updated the task list'
  if (/wrap_up$/.test(tool)) return 'wrapped up the turn'
  if (tool === 'Agent' || tool === 'Task') return `${str(args.subagent_type) ?? 'agent'}: ${str(args.description) ?? ''}`
  // A command's own description is what the app shows as its status line.
  const said = str(args.description)
  if (said && (tool === 'Bash' || tool === 'PowerShell' || tool.endsWith('run_in_terminal'))) return `${tool} · ${said}`
  for (const key of ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'skill']) {
    const value = str(args[key])
    if (value) return `${tool} ${key === 'file_path' ? (value.split(/[\\/]/).pop() ?? value) : value}`
  }
  return tool
}

/** `claude-haiku-5-5` -> `haiku 5.5`. */
export function shortModel(model: string | undefined): string {
  const m = (model ?? '').toLowerCase().replace(/^claude-/, '').replace(/\[.*\]$/, '')
  const parts = m.match(/^(opus|sonnet|haiku|fable)[- ]?(\d+)(?:[-.](\d+))?/)
  if (parts) return parts[3] ? `${parts[1]} ${parts[2]}.${parts[3]}` : `${parts[1]} ${parts[2]}`
  return m || 'unknown'
}

/** The text a person typed, or undefined for tool results, reminders and command output. */
function promptText(content: unknown): string | undefined {
  let text: string | undefined
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some(b => isObj(b) && b.type === 'tool_result')) return undefined
    text = content
      .filter(b => isObj(b) && b.type === 'text')
      .map(b => str((b as Json).text) ?? '')
      .join(' ')
  }
  const t = text?.trim()
  if (!t || t.startsWith('<')) return undefined
  return t
}

const emptyBucket = (): TokenBucket => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** How much of a message between sessions is kept. */
const LINK_TEXT = 4000

/**
 * A tool call that reaches another Claude session: a message to it, or starting one.
 * SendMessage to a subagent of its own (recipient_kind "agent") is not another session.
 */
export function linkFromCall(tool: string, input: unknown, at: number): SessionLink | undefined {
  const args = isObj(input) ? input : {}
  if (tool === 'SendMessage') {
    const to = str(args.to) ?? str(args.recipient) ?? ''
    const kind = str(args.recipient_kind)
    const toSession = kind ? kind === 'session' || kind === 'name' : /^(local_|uds:)/.test(to)
    if (!toSession) return undefined
    const text = str(args.message) ?? str(args.content) ?? ''
    return {
      at,
      kind: 'sent',
      ...(to.startsWith('local_') ? { peerLocal: to } : to.startsWith('uds:') ? { peerAddress: to } : { peerName: to }),
      summary: str(args.summary),
      text: clip(text, LINK_TEXT),
    }
  }
  if (/start_session$/.test(tool) || /hand_off_to_session$/.test(tool)) {
    const handOff = tool.endsWith('hand_off_to_session')
    return {
      at,
      kind: 'started',
      peerName: str(args.title),
      text: clip(str(args.prompt) ?? str(args.remaining_plan) ?? '', LINK_TEXT),
      initiation: handOff ? 'hand-off' : (str(args.initiation) ?? 'offer'),
    }
  }
  return undefined
}

/** Fills in what a tool's result says: delivered or not, the message id, the session's name or id. */
function completeLink(link: SessionLink, toolUseResult: unknown, block: Json) {
  const content = block.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (isObj(b) ? (str(b.text) ?? '') : '')).join('\n') : ''
  let result: Json | undefined = isObj(toolUseResult) ? toolUseResult : undefined
  if (!result) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObj(parsed)) result = parsed
    } catch {
      // Plain text.
    }
  }
  const said = str(result?.message) ?? text
  if (link.kind === 'sent') {
    link.ok = result ? result.success !== false : block.is_error !== true
    link.msgId = str(result?.msg_id) ?? link.msgId
    // "“summary” → Development priorities (another Claude session …)"
    const named = said.match(/→\s*(?:sent to\s+)?(.+?)\s*\((?:another|a) Claude session/)
    if (named && !named[1]!.startsWith('uds:')) link.peerName = named[1]
  } else {
    link.ok = block.is_error !== true && !/declin|refus|not started|cancel/i.test(said.slice(0, 300))
    const local = said.match(/local_[0-9a-f-]{36}/)
    if (local) link.peerLocal = local[0]
  }
  if (!link.ok) link.error = clip(said, 300)
}

/** A question for you in a tool call: a question dialog, a plan to approve, or the question a turn ends with. */
export function waitingFromCall(tool: string, input: unknown, at: number): Waiting | undefined {
  const args = isObj(input) ? input : {}
  const labels = (list: unknown) =>
    Array.isArray(list) ? list.map(o => (isObj(o) ? (str(o.label) ?? str(o.action)) : undefined)).filter((l): l is string => !!l) : []
  if (tool === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions.filter(isObj) : []
    if (questions.length === 0) return undefined
    return {
      kind: 'question',
      text: questions.map(q => str(q.question) ?? '').filter(Boolean).join('\n'),
      options: questions.length === 1 ? labels(questions[0]!.options) : undefined,
      blocked: true,
      at,
    }
  }
  if (tool === 'ExitPlanMode') {
    const plan = str(args.plan) ?? ''
    return { kind: 'plan', text: clip(plan.replace(/^#+\s*/gm, ''), 300) || 'A plan is ready for your approval.', blocked: true, at }
  }
  if (/wrap_up$/.test(tool)) {
    const ask = str(args.ask)
    if (!ask) return undefined
    return { kind: 'asked', text: ask, options: labels(args.actions), blocked: args.blocked === true, at }
  }
  return undefined
}

/** The desktop id of the session this one was forked from, if it was. */
function forkedFrom(content: unknown): string | undefined {
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map(b => (isObj(b) ? (str(b.text) ?? '') : '')) : []
  for (const t of texts) {
    if (!t.includes('forked this session from another session')) continue
    return t.match(/local_[0-9a-f-]{36}/)?.[0]
  }
  return undefined
}

/** One transcript's running state: a main session, or one subagent's own file. */
export class Transcript {
  readonly sessionId: string
  readonly agentId?: string
  who: string
  title = ''
  agentName = ''
  lastPrompt = ''
  cwd = ''
  entrypoint = ''
  startedAt = 0
  lastAt = 0
  model?: string
  advisorModel?: string
  effort?: string
  prompts = 0
  toolCalls = 0
  errors = 0
  contextTokens = 0
  lastAction = ''
  toolMix: Record<string, number> = {}
  tokensByModel: Record<string, TokenBucket> = {}
  /** Per day and model: output and total tokens. */
  daily = new Map<string, { output: number; total: number }>()
  /** `day|weekday:hour` -> tool calls; the day lets the overview keep only its window. */
  hours = new Map<string, number>()
  /** Minute start -> tool calls. */
  minutes = new Map<number, number>()
  /** Every prompt: [time, first words]; the log keeps only recent events. */
  promptMarks: [number, string][] = []
  tasks?: TaskList
  lastSaid?: { at: number; text: string; result?: boolean }
  log: LogEvent[] = []
  advisor: AdvisorCall[] = []
  /** Agent tool_use id -> spawn, for linking subagent files. */
  spawns = new Map<string, { type: string; description: string; at: number }>()
  /** Exchanges with other Claude sessions, oldest first. */
  links: SessionLink[] = []
  /** An open question or plan dialog, until it is answered. */
  pendingAsk?: Waiting & { toolUseId: string }
  /** The question its last turn ended with, until you send a message or it carries on working. */
  lastAsk?: Waiting
  /** Image files Claude opened with Read -> when; they can live anywhere, such as the project. */
  imagesOpened = new Map<string, number>()
  /** tool_use id -> the link its result completes. */
  private pendingLinks = new Map<string, SessionLink>()

  private seenMessages = new Set<string>()
  private lastTextByMessage = new Map<string, string>()

  constructor(sessionId: string, agentId?: string, who = 'main') {
    this.sessionId = sessionId
    this.agentId = agentId
    this.who = who
  }

  /** Read one raw line. Returns false when it was skipped or unreadable. */
  ingestLine(line: string): boolean {
    if (!line || shouldSkip(line)) return false
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      return false
    }
    if (!isObj(rec)) return false
    this.ingest(rec)
    return true
  }

  ingest(rec: Json): void {
    const type = str(rec.type)
    const at = Date.parse(str(rec.timestamp) ?? '') || 0
    if (at) {
      if (!this.startedAt || at < this.startedAt) this.startedAt = at
      if (at > this.lastAt) this.lastAt = at
    }
    if (!this.cwd && str(rec.cwd)) this.cwd = str(rec.cwd)!
    if (!this.entrypoint && str(rec.entrypoint)) this.entrypoint = str(rec.entrypoint)!

    switch (type) {
      case 'custom-title':
        this.title = str(rec.customTitle) ?? this.title
        return
      case 'agent-name':
        this.agentName = str(rec.agentName) ?? this.agentName
        return
      case 'last-prompt':
        this.lastPrompt = str(rec.lastPrompt) ?? this.lastPrompt
        return
      case 'user':
        return this.ingestUser(rec, at)
      case 'assistant':
        return this.ingestAssistant(rec, at)
      default:
        return
    }
  }

  private push(event: Omit<LogEvent, 'sessionId' | 'who' | 'agentId'>) {
    this.log.push({ ...event, sessionId: this.sessionId, who: this.who, agentId: this.agentId })
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
  }

  private ingestUser(rec: Json, at: number) {
    const message = isObj(rec.message) ? rec.message : {}
    const content = message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isObj(block) && block.type === 'tool_result' && block.is_error === true) {
          this.errors++
          this.push({ at, kind: 'error', text: 'tool error', model: this.model })
        }
        if (isObj(block) && block.type === 'tool_result' && this.pendingAsk?.toolUseId === block.tool_use_id) this.pendingAsk = undefined
        if (isObj(block) && block.type === 'tool_result') {
          const link = this.pendingLinks.get(str(block.tool_use_id) ?? '')
          if (link) {
            this.pendingLinks.delete(str(block.tool_use_id)!)
            completeLink(link, rec.toolUseResult, block)
          }
        }
      }
    }
    // A message from another Claude session (a subagent's hand-back has no fromSession).
    const origin = isObj(rec.origin) ? rec.origin : undefined
    if (origin?.kind === 'peer') {
      const fromSession = str(origin.fromSession)
      if (fromSession?.startsWith('local_')) {
        const body = str(origin.body) ?? ''
        this.links.push({
          at,
          kind: 'received',
          peerName: str(origin.name),
          peerLocal: fromSession,
          peerAddress: str(origin.from),
          msgId: str(origin.msg_id),
          text: clip(body, LINK_TEXT),
        })
        this.push({ at, kind: 'prompt', text: `message from ${str(origin.name) ?? 'another session'}: ${clip(body, 120)}`, model: this.model })
      }
      return
    }
    if (origin && origin.kind !== 'human') return
    if (rec.isMeta === true) return
    const forked = forkedFrom(content)
    if (forked && !this.links.some(l => l.kind === 'forked')) this.links.push({ at, kind: 'forked', peerLocal: forked, text: 'Forked from this session' })
    const text = promptText(content)
    if (text) {
      // Your message answers whatever it asked.
      this.lastAsk = undefined
      this.pendingAsk = undefined
      this.prompts++
      if (at) this.promptMarks.push([at, `prompt: ${clip(text, 140)}`])
      // A subagent's prompt is its brief from the lead: keep more of it.
      this.push({ at, kind: 'prompt', text: `prompt: ${clip(text, this.agentId ? 400 : 140)}`, model: this.model })
    }
  }

  private ingestAssistant(rec: Json, at: number) {
    const message = isObj(rec.message) ? rec.message : {}
    const id = str(message.id) ?? str(rec.uuid) ?? ''
    const model = str(message.model)
    if (model && model !== '<synthetic>') this.model = model
    if (str(rec.advisorModel)) this.advisorModel = str(rec.advisorModel)
    if (str(rec.effort)) this.effort = str(rec.effort)

    // One response is split across several records that repeat the same usage: count it once.
    if (id && !this.seenMessages.has(id)) {
      this.seenMessages.add(id)
      const usage = isObj(message.usage) ? message.usage : undefined
      if (usage && model && model !== '<synthetic>') {
        const bucket = (this.tokensByModel[model] ??= emptyBucket())
        const input = num(usage.input_tokens)
        const cacheRead = num(usage.cache_read_input_tokens)
        const cacheWrite = num(usage.cache_creation_input_tokens)
        const output = num(usage.output_tokens)
        bucket.input += input
        bucket.cacheRead += cacheRead
        bucket.cacheWrite += cacheWrite
        bucket.output += output
        // A response that consulted the advisor reports its passes summed; the context is one pass, the last.
        const passes = Array.isArray(usage.iterations) ? usage.iterations.filter(isObj) : []
        const lastPass = passes[passes.length - 1]
        this.contextTokens = lastPass
          ? num(lastPass.input_tokens) + num(lastPass.cache_read_input_tokens) + num(lastPass.cache_creation_input_tokens)
          : input + cacheRead + cacheWrite
        if (at) {
          const key = `${dayOf(at)}|${model}`
          const day = this.daily.get(key) ?? { output: 0, total: 0 }
          day.output += output
          day.total += input + cacheRead + cacheWrite + output
          this.daily.set(key, day)
        }
      }
    }

    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (!isObj(block)) continue
      if (block.type === 'text') {
        const text = str(block.text)?.trim()
        if (text && id) this.lastTextByMessage.set(id, text)
        if (text) this.lastSaid = { at, text: clip(text, 600) }
      } else if (block.type === 'tool_use') {
        const name = str(block.name) ?? 'tool'
        this.toolCalls++
        this.toolMix[name] = (this.toolMix[name] ?? 0) + 1
        const text = clip(describeCall(name, block.input), 140)
        const bookkeeping = isTaskTool(name)
        // A subagent's hand-back carries its report to the lead: show it as its result.
        if (name === 'SubagentHandback' && isObj(block.input)) {
          const report = str(block.input.message) ?? str(block.input.result)
          if (report) this.lastSaid = { at, text: clip(report, 1200), result: true }
        }
        if (bookkeeping) this.tasks = applyTaskUpdate(this.tasks, name, block.input, at)
        // The task list and wrap-up aren't work: "doing now" keeps the last real step.
        else this.lastAction = text
        if (at) {
          const d = new Date(at)
          const hourKey = `${dayOf(at)}|${(d.getDay() + 6) % 7}:${d.getHours()}`
          this.hours.set(hourKey, (this.hours.get(hourKey) ?? 0) + 1)
          const minute = at - (at % 60_000)
          this.minutes.set(minute, (this.minutes.get(minute) ?? 0) + 1)
        }
        const waiting = waitingFromCall(name, block.input, at)
        if (waiting && (name === 'AskUserQuestion' || name === 'ExitPlanMode')) this.pendingAsk = { ...waiting, toolUseId: str(block.id) ?? '' }
        else if (/wrap_up$/.test(name)) this.lastAsk = waiting
        // Working again: an earlier question is no longer what it waits on.
        else if (!isTaskTool(name)) this.lastAsk = undefined
        if (name === 'Read' && isObj(block.input)) {
          const file = str(block.input.file_path)
          if (file && /\.(png|jpe?g|webp|gif)$/i.test(file)) this.imagesOpened.set(file, at)
        }
        const link = linkFromCall(name, block.input, at)
        if (link) {
          this.links.push(link)
          if (str(block.id)) this.pendingLinks.set(str(block.id)!, link)
        }
        if (name === 'Agent' || name === 'Task') {
          const input = isObj(block.input) ? block.input : {}
          const type = str(input.subagent_type) ?? 'general-purpose'
          const toolUseId = str(block.id)
          if (toolUseId) this.spawns.set(toolUseId, { type, description: str(input.description) ?? '', at })
          this.push({ at, kind: 'agent-start', text: `${type} started: ${clip(str(input.description) ?? '', 100)}`, model: this.model })
        } else {
          this.push({ at, kind: 'tool', text, model: this.model })
        }
      } else if (block.type === 'server_tool_use' && block.name === 'advisor') {
        const before = (id && this.lastTextByMessage.get(id)) || ''
        const about = before ? clip(before, 400) : this.lastAction ? `after ${this.lastAction}` : 'start of turn'
        this.advisor.push({ at, sessionId: this.sessionId, who: this.who, about })
        this.push({ at, kind: 'advisor', text: `consulted on: ${clip(about, 120)}`, model: this.advisorModel ?? 'opus' })
      }
    }
  }

  get outputTokens(): number {
    return Object.values(this.tokensByModel).reduce((sum, b) => sum + b.output, 0)
  }
}

/** The app's task-list tool, the terminal's TodoWrite, and the turn wrap-up. */
export function isTaskTool(name: string): boolean {
  return /update_plan$|^TodoWrite$|wrap_up$/.test(name)
}

const STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed']
const asStatus = (v: unknown): TaskStatus => (STATUSES.includes(v as TaskStatus) ? (v as TaskStatus) : 'pending')

/**
 * Replays one task-list call onto the list, the way the app shows it:
 * `items` replaces the list, `advance` finishes the running step and starts the
 * next, `done`/`start` (1-based) set steps, and a wrap-up checks everything off.
 */
export function applyTaskUpdate(list: TaskList | undefined, tool: string, input: unknown, at: number): TaskList | undefined {
  const args = isObj(input) ? input : {}

  if (tool === 'TodoWrite') {
    const todos = Array.isArray(args.todos) ? args.todos.filter(isObj) : []
    return { items: todos.map(t => ({ content: str(t.content) ?? '', status: asStatus(t.status) })), updatedAt: at }
  }

  if (/wrap_up$/.test(tool)) {
    if (!list) return str(args.recap) ? { items: [], updatedAt: at, recap: str(args.recap) } : undefined
    return { items: list.items.map(i => ({ ...i, status: 'completed' })), updatedAt: at, recap: str(args.recap) }
  }

  if (Array.isArray(args.items)) {
    const items = args.items.filter(isObj).map(i => ({ content: str(i.content) ?? '', status: asStatus(i.status) }))
    return { items, updatedAt: at }
  }
  if (!list) return undefined

  const items = list.items.map(i => ({ ...i }))
  if (args.advance === true) {
    const running = items.findIndex(i => i.status === 'in_progress')
    if (running >= 0) items[running]!.status = 'completed'
    const next = items.findIndex((i, n) => n > running && i.status === 'pending')
    if (next >= 0) items[next]!.status = 'in_progress'
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done) if (typeof n === 'number' && items[n - 1]) items[n - 1]!.status = 'completed'
  }
  if (typeof args.start === 'number' && items[args.start - 1]) {
    for (const i of items) if (i.status === 'in_progress') i.status = 'pending'
    items[args.start - 1]!.status = 'in_progress'
  }
  return { items, updatedAt: at, recap: list.recap }
}

export function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function statusOf(lastAt: number, now: number): SessionStatus {
  if (now - lastAt < LIVE_MS) return 'live'
  if (now - lastAt < RECENT_MS) return 'recent'
  return 'idle'
}

export interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  finished?: boolean
}

/** A main session with its subagents. */
export class Session {
  readonly main: Transcript
  readonly agents = new Map<string, { transcript: Transcript; meta: SubagentMeta }>()

  constructor(readonly id: string) {
    this.main = new Transcript(id)
  }

  agent(agentId: string, meta: SubagentMeta): Transcript {
    let entry = this.agents.get(agentId)
    if (!entry) {
      entry = { transcript: new Transcript(this.id, agentId, meta.agentType ?? 'agent'), meta }
      this.agents.set(agentId, entry)
    } else {
      entry.meta = { ...entry.meta, ...meta }
      if (meta.agentType) entry.transcript.who = meta.agentType
    }
    return entry.transcript
  }

  subagents(now: number): SubagentRun[] {
    return [...this.agents.entries()]
      .map(([id, { transcript: t, meta }]) => {
        const spawn = meta.toolUseId ? this.main.spawns.get(meta.toolUseId) : undefined
        // A file that stopped growing long ago is done even if its meta never said so.
        const done = meta.finished === true || (t.lastAt > 0 && now - t.lastAt > RECENT_MS)
        return {
          id,
          type: meta.agentType ?? spawn?.type ?? t.who,
          description: meta.description ?? spawn?.description ?? '',
          model: t.model,
          startedAt: spawn?.at || t.startedAt,
          endedAt: done ? t.lastAt : undefined,
          status: done ? 'done' : 'running',
          toolCalls: t.toolCalls,
          outputTokens: t.outputTokens,
          lastAction: t.lastAction,
          recent: t.log
            .filter(e => e.kind !== 'prompt')
            .slice(-4)
            .map(({ at, kind, text }) => ({ at, kind, text })),
          lastSaid: t.lastSaid,
          tasks: t.tasks,
        } satisfies SubagentRun
      })
      .filter(r => r.startedAt > 0)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  lastAt(): number {
    let last = this.main.lastAt
    for (const { transcript } of this.agents.values()) last = Math.max(last, transcript.lastAt)
    return last
  }

  summary(now: number): SessionSummary {
    const m = this.main
    const runs = this.subagents(now)
    const lastAt = this.lastAt()
    const cwd = m.cwd
    return {
      id: this.id,
      cwd,
      projectName: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
      title: m.title || m.agentName || clip(m.lastPrompt, 80) || this.id.slice(0, 8),
      entrypoint: m.entrypoint,
      startedAt: m.startedAt,
      lastAt,
      status: statusOf(lastAt, now),
      mainModel: m.model,
      advisorModel: m.advisorModel,
      effort: m.effort,
      prompts: m.prompts,
      toolCalls: m.toolCalls,
      errors: m.errors,
      advisorCalls: m.advisor.length + [...this.agents.values()].reduce((n, a) => n + a.transcript.advisor.length, 0),
      subagentsRunning: runs.filter(r => r.status === 'running').length,
      subagentsTotal: runs.length,
      contextTokens: m.contextTokens,
      outputTokens: m.outputTokens + [...this.agents.values()].reduce((n, a) => n + a.transcript.outputTokens, 0),
      lastAction: m.lastAction,
      talks: m.links.filter(l => l.kind === 'sent' || l.kind === 'received').length,
      waiting: m.pendingAsk ? { kind: m.pendingAsk.kind, text: m.pendingAsk.text, options: m.pendingAsk.options, blocked: true, at: m.pendingAsk.at } : m.lastAsk,
    }
  }

  log(): LogEvent[] {
    const all = [...this.main.log]
    for (const { transcript } of this.agents.values()) all.push(...transcript.log)
    for (const run of this.subagents(Date.now())) {
      if (run.endedAt) all.push({ at: run.endedAt, sessionId: this.id, who: run.type, agentId: run.id, model: run.model, kind: 'agent-done', text: `${run.type} done` })
    }
    return all.sort((a, b) => a.at - b.at).slice(-LOG_CAP)
  }

  /** One subagent's own log, which the session log may have cut for older runs. */
  agentLog(agentId: string): LogEvent[] | undefined {
    return this.agents.get(agentId)?.transcript.log
  }

  /** Every image this session or its subagents opened, newest time per file. */
  imagesOpened(): Map<string, number> {
    const all = new Map(this.main.imagesOpened)
    for (const { transcript } of this.agents.values()) for (const [f, at] of transcript.imagesOpened) all.set(f, Math.max(at, all.get(f) ?? 0))
    return all
  }

  advisorCalls(): AdvisorCall[] {
    const all = [...this.main.advisor]
    for (const { transcript } of this.agents.values()) all.push(...transcript.advisor)
    return all.sort((a, b) => a.at - b.at)
  }

  detail(now: number): SessionDetail {
    const tokensByModel: Record<string, TokenBucket> = {}
    const toolMix: Record<string, number> = { ...this.main.toolMix }
    for (const t of [this.main, ...[...this.agents.values()].map(a => a.transcript)]) {
      for (const [model, b] of Object.entries(t.tokensByModel)) {
        const into = (tokensByModel[model] ??= emptyBucket())
        into.input += b.input
        into.cacheRead += b.cacheRead
        into.cacheWrite += b.cacheWrite
        into.output += b.output
      }
    }
    for (const { transcript } of this.agents.values()) {
      for (const [name, n] of Object.entries(transcript.toolMix)) toolMix[name] = (toolMix[name] ?? 0) + n
    }
    return {
      ...this.summary(now),
      subagents: this.subagents(now),
      advisor: this.advisorCalls(),
      toolMix,
      tokensByModel,
      activity: [...this.main.minutes.entries()].sort((a, b) => a[0] - b[0]),
      promptMarks: this.main.promptMarks,
      tasks: this.main.tasks,
      lastSaid: this.main.lastSaid,
      links: this.main.links,
      log: this.log(),
    }
  }
}
