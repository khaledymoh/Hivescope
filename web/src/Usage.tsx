import { useMemo, useState } from 'react'

import type { Alert, Budgets, Overview, SessionSummary, Spend, Usage } from '../../shared/types'
import { Chart, axis, tooltip } from './Chart'
import { Panel } from './parts'
import { C, ago, family, modelColor, shortModel, usd, when } from './theme'

const API_NOTE = 'API-equivalent: what these tokens would cost at Anthropic API prices. On a subscription you pay a flat price instead.'

async function post(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hivescope': 'change' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json()
}

function Meter({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="meter usage-meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  )
}

const levelColor = (pct: number) => (pct >= 95 ? C.error : pct >= 80 ? C.honey : C.done)

/** One window: its API-equivalent cost, and how far into your budget it is. */
function Window({ label, spend, sub, budget }: { label: string; spend?: Spend; sub: string; budget?: number }) {
  const cost = spend?.cost ?? 0
  const budgetPct = budget ? (100 * cost) / budget : undefined
  const models = Object.entries(spend?.byModel ?? {})
    .filter(([, v]) => v >= 0.005)
    .sort((a, b) => b[1] - a[1])
  return (
    <div className="usage-window">
      <div className="usage-h">
        <span className="usage-label">{label}</span>
        <span className="usage-sub">{sub}</span>
      </div>
      <div className="usage-big">
        {usd(cost)} {budget ? <span className="usage-of">of {usd(budget)} budget</span> : <span className="usage-of">at API prices</span>}
      </div>
      {budgetPct !== undefined && <Meter pct={budgetPct} color={levelColor(budgetPct)} />}
      {models.length > 0 && (
        <div className="usage-models">
          {models.slice(0, 4).map(([m, v]) => (
            <span key={m} style={{ color: modelColor(m) }}>
              {shortModel(m)} {usd(v)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function BudgetEditor({ budgets, onDone }: { budgets: Budgets; onDone: () => void }) {
  const [draft, setDraft] = useState<Record<keyof Budgets, string>>({
    fiveHour: budgets.fiveHour ? String(budgets.fiveHour) : '',
    day: budgets.day ? String(budgets.day) : '',
    week: budgets.week ? String(budgets.week) : '',
  })
  const [error, setError] = useState('')
  const save = async () => {
    const value = (s: string) => (s.trim() === '' ? undefined : Number(s))
    const next = { fiveHour: value(draft.fiveHour), day: value(draft.day), week: value(draft.week) }
    if (Object.values(next).some(v => v !== undefined && !(v > 0))) return setError('Use a positive number of dollars, or leave it empty for no limit.')
    try {
      await post('/api/settings', { budgets: next })
      onDone()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }
  const field = (key: keyof Budgets, label: string) => (
    <label className="budget-field">
      <span>{label}</span>
      <span className="budget-input">
        $<input inputMode="decimal" value={draft[key]} placeholder="no limit" onChange={e => setDraft({ ...draft, [key]: e.target.value })} />
      </span>
    </label>
  )
  return (
    <div className="budget-editor">
      <p className="dim small">Hivescope notifies you at 80% and 100% of a budget. Amounts are API-equivalent dollars.</p>
      <div className="budget-fields">
        {field('fiveHour', '5-hour window')}
        {field('day', 'Day')}
        {field('week', 'Week')}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="budget-buttons">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()}>
          Save budgets
        </button>
      </div>
    </div>
  )
}

/** The current 5-hour window, today and this week, at API-equivalent cost. */
export function UsagePanel({ usage }: { usage: Usage }) {
  const [editing, setEditing] = useState(false)
  const now = Date.now()
  const five = usage.fiveHour

  const blocksOption = useMemo(
    () => ({
      grid: { left: 44, right: 10, top: 10, bottom: 24 },
      tooltip: { ...tooltip, trigger: 'axis' as const, valueFormatter: (v: unknown) => usd(Number(v)) },
      xAxis: { type: 'category' as const, data: usage.blocks.map(b => when(b.start)), ...axis, axisLabel: { color: C.dim, hideOverlap: true } },
      yAxis: { type: 'value' as const, ...axis, axisLabel: { color: C.dim, formatter: (v: number) => usd(v) } },
      series: [
        {
          type: 'bar' as const,
          barMaxWidth: 18,
          data: usage.blocks.map(b => ({ value: b.cost, itemStyle: { color: b.end > now ? C.honey : '#7a5a1e', borderRadius: [3, 3, 0, 0] } })),
          markLine: usage.budgets.fiveHour
            ? { symbol: 'none', silent: true, lineStyle: { color: C.error, type: 'dashed' as const }, label: { color: C.error, formatter: 'budget' }, data: [{ yAxis: usage.budgets.fiveHour }] }
            : undefined,
        },
      ],
    }),
    [usage.blocks, usage.budgets.fiveHour, now],
  )

  const left = five ? Math.max(0, five.end - now) : 0
  const fiveSub = five ? `ends ${when(five.end)} · ${left >= 3_600_000 ? `${Math.floor(left / 3_600_000)}h ${Math.round((left % 3_600_000) / 60_000)}m` : `${Math.round(left / 60_000)} min`} left` : 'starts with your next message'
  return (
    <Panel title="Usage" note="API-equivalent cost of Claude Code on this computer" wide>
      <div className="usage-row">
        <Window label="5-hour window" spend={five} sub={fiveSub} budget={usage.budgets.fiveHour} />
        <Window label="Today" spend={usage.today} sub="since midnight" budget={usage.budgets.day} />
        <Window label="This week" spend={usage.week} sub="last 7 days" budget={usage.budgets.week} />
        <div className="usage-window usage-chart">
          <div className="usage-h">
            <span className="usage-label">5-hour windows</span>
            <span className="usage-sub">last 7 days</span>
          </div>
          {usage.blocks.length ? <Chart option={blocksOption} height={120} /> : <p className="empty">No activity in the last 7 days.</p>}
        </div>
      </div>
      <div className="usage-foot">
        <span className="dim small" title={API_NOTE}>
          Dollar amounts are API-equivalent, not a bill.
        </span>
        {!editing && (
          <button className="link small" onClick={() => setEditing(true)}>
            {Object.values(usage.budgets).some(Boolean) ? 'Change budgets' : 'Set budgets'}
          </button>
        )}
      </div>
      {editing && <BudgetEditor budgets={usage.budgets} onDone={() => setEditing(false)} />}
    </Panel>
  )
}

const ALERT_ICON: Record<Alert['kind'], string> = { context: '⚑', error: '✕', stalled: '⏸', budget: '$' }

/** Alerts worth a look now: the desktop app also sends each one as a notification. */
export function AlertsPanel({ alerts, onOpen }: { alerts: Alert[]; onOpen: (id: string) => void }) {
  if (alerts.length === 0) return null
  return (
    <Panel title="Needs attention" note={`${alerts.length} alert${alerts.length === 1 ? '' : 's'}`} wide>
      <ul className="alerts">
        {alerts.map(a => (
          <li key={a.id} className={`alert ${a.kind}`}>
            <span className="alert-icon" aria-hidden>
              {ALERT_ICON[a.kind]}
            </span>
            <div className="alert-body">
              {a.sessionId ? (
                <button className="link alert-title" onClick={() => onOpen(a.sessionId!)}>
                  {a.title}
                </button>
              ) : (
                <span className="alert-title">{a.title}</span>
              )}
              <span className="alert-text">{a.text}</span>
            </div>
            <span className="dim small">{ago(a.at)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'other'] as const

/** API-equivalent cost per day, stacked by model family. */
export function CostPerDay({ overview }: { overview: Overview }) {
  const option = useMemo(() => {
    const days = [...new Set(overview.daily.map(d => d.day))].sort()
    const sum = (day: string, f: string) => overview.daily.filter(d => d.day === day && family(d.model) === f).reduce((n, d) => n + d.cost, 0)
    return {
      grid: { left: 52, right: 12, top: 30, bottom: 28 },
      legend: { top: 0, right: 0, textStyle: { color: C.dim }, itemWidth: 10, itemHeight: 10 },
      tooltip: { ...tooltip, trigger: 'axis' as const, valueFormatter: (v: unknown) => usd(Number(v)) },
      xAxis: { type: 'category' as const, data: days.map(d => d.slice(5)), ...axis },
      yAxis: { type: 'value' as const, ...axis, axisLabel: { color: C.dim, formatter: (v: number) => usd(v) } },
      series: FAMILIES.map(f => ({
        name: f,
        type: 'bar' as const,
        stack: 'cost',
        barMaxWidth: 34,
        itemStyle: { color: C[f], borderRadius: f === 'other' ? [3, 3, 0, 0] : 0 },
        data: days.map(d => sum(d, f)),
      })),
    }
  }, [overview.daily])
  const total = overview.daily.reduce((n, d) => n + d.cost, 0)
  return (
    <Panel title="Cost per day" note={`${usd(total)} in ${overview.windowDays} days · API-equivalent`}>
      <Chart option={option} height={250} />
    </Panel>
  )
}

export function ProjectsPanel({ projects }: { projects: Overview['projects'] }) {
  const top = projects.slice(0, 8)
  const max = Math.max(0.01, ...top.map(p => p.cost))
  return (
    <Panel title="Cost by project" note="API-equivalent, in the window">
      {top.length === 0 ? (
        <p className="empty">No usage in the window.</p>
      ) : (
        <ul className="projects">
          {top.map(p => (
            <li key={p.name}>
              <span className="mono project-name" title={p.name}>
                {p.name}
              </span>
              <span className="project-bar">
                <span style={{ width: `${(100 * p.cost) / max}%` }} />
              </span>
              <span className="num">{usd(p.cost)}</span>
              <span className="dim small">{p.sessions} session{p.sessions === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Sessions where the lead did work the routing rules hand to cheaper agents. */
export function MissedPanel({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  const flagged = sessions.filter(s => s.missed > 0).sort((a, b) => b.missedCost - a.missedCost)
  const spent = flagged.reduce((n, s) => n + s.missedCost, 0)
  const stretches = flagged.reduce((n, s) => n + s.missed, 0)
  return (
    <Panel
      title="Missed delegations"
      note={flagged.length ? `${stretches} possible · the lead spent ${usd(spent)} on them` : 'none found'}
      wide
    >
      {flagged.length === 0 ? (
        <p className="empty">The lead handed off its lookups, builds and test runs, or ran on a model no cheaper agent beats.</p>
      ) : (
        <>
          <p className="dim small missed-why">
            Reads and searches in five or more responses in a row with nothing edited, or two or more builds and test runs in one turn, done by the lead instead of a cheaper subagent. Parallel calls in one response count as one step; reads of files it then edited, and of screenshots, don't count.
          </p>
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Lead</th>
                  <th className="num">Stretches</th>
                  <th className="num">Lead spent</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map(s => (
                  <tr key={s.id}>
                    <td className="task">
                      <button className="link" onClick={() => onOpen(s.id)}>
                        {s.title}
                      </button>
                    </td>
                    <td style={{ color: modelColor(s.mainModel) }}>{shortModel(s.mainModel)}</td>
                    <td className="num">{s.missed}</td>
                    <td className="num">{usd(s.missedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}
