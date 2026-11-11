/** Data the Hivescope server sends to the page. Times are epoch milliseconds. */

export type LogKind = 'prompt' | 'tool' | 'agent-start' | 'agent-done' | 'advisor' | 'error'

export interface LogEvent {
  at: number
  sessionId: string
  /** `main`, or the subagent's type (`worker`, `quick`...). */
  who: string
  agentId?: string
  model?: string
  kind: LogKind
  text: string
}

export interface SubagentRun {
  id: string
  type: string
  description: string
  model?: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done'
  toolCalls: number
  outputTokens: number
  /** Its latest tool call, as the lead's "doing now". */
  lastAction: string
  /** Its last few steps, oldest first. */
  recent: { at: number; kind: LogKind; text: string }[]
  /** What it last wrote, often its findings or result. */
  lastSaid?: { at: number; text: string; result?: boolean }
  /** Its own task list, when it keeps one. */
  tasks?: TaskList
}

export interface AdvisorCall {
  at: number
  sessionId: string
  who: string
  /** What Claude wrote just before calling the advisor. The reply itself is stored encrypted. */
  about: string
}

export interface TokenBucket {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export type SessionStatus = 'live' | 'recent' | 'idle'

/**
 * What a session waits on you for:
 * question: a question dialog is open · plan: a plan waits for approval ·
 * dialog: a permission or other dialog is open · asked: its turn ended with a question for you.
 */
export interface Waiting {
  kind: 'question' | 'plan' | 'dialog' | 'asked'
  /** The question, or what the dialog is for. */
  text: string
  /** The answers it offers, when it gave some. */
  options?: string[]
  /** It can't go on until you answer. */
  blocked?: boolean
  at: number
}

export interface SessionSummary {
  id: string
  cwd: string
  projectName: string
  title: string
  entrypoint: string
  startedAt: number
  lastAt: number
  status: SessionStatus
  mainModel?: string
  advisorModel?: string
  /** The lead's reasoning effort on its latest response (`low` to `max`). */
  effort?: string
  prompts: number
  toolCalls: number
  errors: number
  advisorCalls: number
  subagentsRunning: number
  subagentsTotal: number
  /** Tokens the last main response read as context (input + cache). */
  contextTokens: number
  outputTokens: number
  lastAction: string
  /** Messages it sent to or received from other Claude sessions. */
  talks: number
  /** Set while it waits on you; only for sessions whose app or terminal is still open. */
  waiting?: Waiting
  /** What its running process reports: working, idle, or waiting on you. Unset when it isn't running. */
  runState?: 'busy' | 'idle' | 'waiting'
}

/** At this share of the context window, Hivescope flags a session to compact. */
export const COMPACT_AT = 0.4

/**
 * The context window of a model, in tokens. Current models (Opus 4.6+, Sonnet 4.6+,
 * Haiku 5.5, Fable 5+) have 1M; Haiku 4.5 and models before the 4.6 generation have 200K.
 */
export function contextWindow(model: string | undefined): number {
  const m = (model ?? '').toLowerCase()
  if (m.includes('[1m]')) return 1_000_000
  const parts = m.replace(/^claude-/, '').match(/^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/)
  if (!parts) return 1_000_000
  const [, family, major = '0', minor = '0'] = parts
  const version = Number(major) + Number(minor) / 10
  if (family === 'haiku') return version >= 5 ? 1_000_000 : 200_000
  if (family === 'fable' || family === 'mythos') return 1_000_000
  return version >= 4.6 ? 1_000_000 : 200_000
}

/**
 * tool: a tool's screenshot · scratchpad: an image an agent saved · pasted: an image you pasted in ·
 * opened: an image saved anywhere else (such as your project) that Claude opened; shown, never deleted.
 */
export type ShotKind = 'tool' | 'scratchpad' | 'pasted' | 'opened'

export interface ShotFile {
  /** Opaque; the server checks it again before serving or deleting. */
  id: string
  name: string
  kind: ShotKind
  /** Where an opened image lives. */
  path?: string
  sessionId: string
  bytes: number
  at: number
}

export interface ShotSession {
  sessionId: string
  /** Unknown for sessions older than the window or whose transcript is gone. */
  title?: string
  projectName?: string
  live: boolean
  count: number
  bytes: number
  byKind: Record<ShotKind, { count: number; bytes: number }>
  lastAt: number
}

/**
 * What agents leave behind on disk, and nothing else:
 * tasks: background command output · scratchpad: an agent's temporary files · screenshots: tools' saved screenshots.
 */
export type LeftoverKind = 'tasks' | 'scratchpad' | 'screenshots'
export const LEFTOVER_KINDS: LeftoverKind[] = ['tasks', 'scratchpad', 'screenshots']

export interface FileStat {
  files: number
  bytes: number
}

export interface SpaceSession {
  sessionId: string
  /** Unknown for sessions older than the window or whose transcript is gone. */
  title?: string
  projectName?: string
  live: boolean
  /** Newest leftover file of this session. */
  lastAt: number
  /** What can be freed now, per kind. */
  free: Record<LeftoverKind, FileStat>
  /** Kept for now: the session is live or was active lately, or the file was just written. */
  held: FileStat
}

export interface SpaceReport {
  scannedAt: number
  /** Files and sessions touched within this many hours are kept. */
  quietHours: number
  totals: Record<LeftoverKind, { free: FileStat; held: FileStat }>
  sessions: SpaceSession[]
}

/**
 * One exchange between this session and another Claude session:
 * sent / received: a message (SendMessage) · started: it started or proposed a session · forked: it was forked from one.
 */
export type LinkKind = 'sent' | 'received' | 'started' | 'forked'

export interface SessionLink {
  at: number
  kind: LinkKind
  /** The other side as this transcript names it: its title, desktop id (`local_…`) or message address. */
  peerName?: string
  peerLocal?: string
  peerAddress?: string
  /** The other session's transcript id and title, when Hivescope could tell which one it is. */
  peerSessionId?: string
  peerTitle?: string
  /** The sender's one-line summary of a message. */
  summary?: string
  /** The message, or the brief a started session was given. */
  text: string
  /** The same id on both sides of a message. */
  msgId?: string
  /** For a sent message or a started session: whether it went through. */
  ok?: boolean
  error?: string
  /** For a started session: offer, own_initiative, user_asked or hand-off. */
  initiation?: string
}

/** Messages between two sessions, for the overview's graph. */
export interface SessionEdge {
  from: string
  to: string
  count: number
  lastAt: number
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** The task list Claude keeps for the current request, as the app shows it. */
export interface TaskList {
  items: { content: string; status: TaskStatus }[]
  updatedAt: number
  /** The closing recap, once the turn has wrapped up. */
  recap?: string
}

export interface SessionDetail extends SessionSummary {
  subagents: SubagentRun[]
  advisor: AdvisorCall[]
  toolMix: Record<string, number>
  tokensByModel: Record<string, TokenBucket>
  /** Main-session tool calls per minute: [minute start, count]. */
  activity: [number, number][]
  /** Every prompt in the main session: [time, first words]. */
  promptMarks: [number, string][]
  tasks?: TaskList
  /** What Claude last wrote to you, and when. */
  lastSaid?: { at: number; text: string; result?: boolean }
  /** Its exchanges with other Claude sessions, oldest first. */
  links: SessionLink[]
  log: LogEvent[]
}

export interface DailyModelTokens {
  day: string
  model: string
  output: number
  total: number
}

export interface Overview {
  generatedAt: number
  windowDays: number
  sessions: SessionSummary[]
  daily: DailyModelTokens[]
  /** [weekday 0-6 (Mon first), hour 0-23, tool calls]. */
  heatmap: [number, number, number][]
  log: LogEvent[]
  /** The newest 50 advisor calls in the window. */
  advisor: AdvisorCall[]
  /** All advisor calls in the window. */
  advisorCount: number
  /** Which sessions messaged which, in the window. */
  edges: SessionEdge[]
  /** The newest 40 messages between sessions, newest first; each names its sender session. */
  messages: (SessionLink & { sessionId: string })[]
  scan: { files: number; bytes: number; ms: number }
}
