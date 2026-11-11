/** Sorting sessions into sidebar groups: by project, status or day. */
import type { SessionSummary } from '../../shared/types'
import { dayOf } from './theme'

export type GroupBy = 'project' | 'status' | 'day' | 'none'

export const GROUP_LABELS: Record<GroupBy, string> = {
  project: 'Project',
  status: 'Status',
  day: 'Day',
  none: 'None',
}

export interface Group {
  key: string
  label: string
  /** Shown on hover, such as the full project path. */
  hint?: string
  sessions: SessionSummary[]
  live: number
}

const STATUS_LABEL = { waiting: 'Waiting for you', live: 'Live now', recent: 'Last 30 minutes', idle: 'Earlier' } as const
const STATUS_ORDER = ['waiting', 'live', 'recent', 'idle'] as const

function dayLabel(day: string, now: number): string {
  if (day === dayOf(now)) return 'Today'
  if (day === dayOf(now - 86_400_000)) return 'Yesterday'
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })
}

/** Sessions arrive newest first; groups keep that order and are ordered by their newest session. */
export function groupSessions(sessions: SessionSummary[], by: GroupBy, now = Date.now()): Group[] {
  if (by === 'none') return [{ key: 'all', label: 'All', sessions, live: sessions.filter(s => s.status === 'live').length }]

  const groups = new Map<string, Group>()
  for (const s of sessions) {
    let key: string
    let label: string
    let hint: string | undefined
    if (by === 'project') {
      // The full folder tells apart two projects with the same folder name.
      key = s.cwd.toLowerCase() || '(unknown)'
      label = s.projectName || 'Unknown folder'
      hint = s.cwd
    } else if (by === 'status') {
      // Sessions waiting on you come first, whatever their age.
      key = s.waiting ? 'waiting' : s.status
      label = STATUS_LABEL[key as keyof typeof STATUS_LABEL]
    } else {
      key = dayOf(s.lastAt)
      label = dayLabel(key, now)
    }
    let group = groups.get(key)
    if (!group) {
      group = { key, label, hint, sessions: [], live: 0 }
      groups.set(key, group)
    }
    group.sessions.push(s)
    if (s.status === 'live') group.live++
  }

  const list = [...groups.values()]
  if (by === 'status') list.sort((a, b) => STATUS_ORDER.indexOf(a.key as never) - STATUS_ORDER.indexOf(b.key as never))
  // Same folder name in two places: show enough of the path to tell them apart.
  if (by === 'project') {
    const names = new Map<string, number>()
    for (const g of list) names.set(g.label, (names.get(g.label) ?? 0) + 1)
    for (const g of list) {
      if ((names.get(g.label) ?? 0) > 1 && g.hint) g.label = g.hint.split(/[\\/]/).filter(Boolean).slice(-2).join('\\')
    }
  }
  return list
}

/** A preference kept in this browser only; any storage failure falls back to the default. */
export function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`hivescope.${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(`hivescope.${key}`, JSON.stringify(value))
  } catch {
    // Not remembered; nothing else depends on it.
  }
}
