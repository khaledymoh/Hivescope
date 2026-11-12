/**
 * Spend over time and the alerts worth a notification. Pure functions over what the
 * transcripts hold, so they can be tested without files.
 */
import type { Alert, Budgets, Spend, Usage } from '../shared/types.ts'

/** [time, cost, output tokens, model] for one model call. */
export type SpendEvent = [number, number, number, string]

const HOUR = 3_600_000
export const FIVE_HOURS = 5 * HOUR
export const WEEK = 7 * 24 * HOUR

function sum(events: SpendEvent[], start: number, end: number): Spend {
  const s: Spend = { start, end, cost: 0, output: 0, byModel: {} }
  for (const [at, cost, output, model] of events) {
    if (at < start || at >= end) continue
    s.cost += cost
    s.output += output
    s.byModel[model] = (s.byModel[model] ?? 0) + cost
  }
  return s
}

/**
 * 5-hour windows the way plans count them: one starts with the first message after the last one
 * ended (from the start of that hour) and lasts five hours. Events must be sorted by time.
 */
export function fiveHourBlocks(events: SpendEvent[]): Spend[] {
  const blocks: Spend[] = []
  let current: Spend | undefined
  for (const [at, cost, output, model] of events) {
    if (!current || at >= current.end) {
      const start = at - (at % HOUR)
      current = { start, end: start + FIVE_HOURS, cost: 0, output: 0, byModel: {} }
      blocks.push(current)
    }
    current.cost += cost
    current.output += output
    current.byModel[model] = (current.byModel[model] ?? 0) + cost
  }
  return blocks
}

export function usageOf(events: SpendEvent[], now: number, budgets: Budgets): Usage {
  const sorted = events.filter(e => e[0] >= now - WEEK - FIVE_HOURS && e[0] <= now).sort((a, b) => a[0] - b[0])
  const blocks = fiveHourBlocks(sorted).filter(b => b.end > now - WEEK)

  // The 5-hour window is estimated from activity: the last block, if it hasn't ended.
  const last = blocks[blocks.length - 1]
  const fiveHour = last && last.end > now ? last : undefined

  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = sum(sorted, midnight.getTime(), midnight.getTime() + 24 * HOUR)
  const week = sum(sorted, now - WEEK, now + 1)

  return { fiveHour, today, week, blocks, budgets }
}

/** Short, stable text hash for alert ids. */
export function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Budgets you set: an alert at 80% and another at 100%. */
export function spendAlerts(usage: Usage, now: number): Alert[] {
  const out: Alert[] = []
  const windows: [keyof Budgets, string, Spend | undefined][] = [
    ['fiveHour', 'this 5-hour window', usage.fiveHour],
    ['day', 'today', usage.today],
    ['week', 'this week', usage.week],
  ]
  for (const [key, label, spend] of windows) {
    const limit = usage.budgets[key]
    if (!limit || !spend) continue
    const pct = (100 * spend.cost) / limit
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0
    if (!level) continue
    // A rolling week has no fixed start: once a day at most.
    const period = key === 'week' ? new Date(now).toDateString() : spend.start
    out.push({
      id: `budget:${key}:${period}:${level}`,
      kind: 'budget',
      title: level === 100 ? `Budget reached for ${label}` : `${Math.floor(pct)}% of your budget for ${label}`,
      text: `${usd(spend.cost)} of ${usd(limit)} at API prices${key === 'fiveHour' ? `, window ends ${clock(spend.end)}` : ''}.`,
      at: now,
    })
  }
  return out
}
