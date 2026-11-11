import { useEffect, useMemo, useState } from 'react'

import { COMPACT_AT, type SessionSummary, contextWindow } from '../../shared/types'
import { type Overview, type SessionDetail, useLive, useVersion } from './api'
import { OverviewView } from './OverviewView'
import { SessionView } from './SessionView'
import { SpaceView } from './Space'
import { NotificationsButton, UpdateButton } from './Update'
import { GROUP_LABELS, type GroupBy, groupSessions, remember, remembered } from './groups'
import { C, ago, dayOf, family, modelColor, shortModel, tokens } from './theme'

export function App() {
  const { version, connected } = useVersion()
  const overview = useLive<Overview>('/api/overview', version)
  const [selected, setSelected] = useState<string | undefined>(() => location.hash.slice(1) || undefined)
  const [query, setQuery] = useState('')
  const storage = selected === 'storage'
  const [measuring, setMeasuring] = useState(false)
  const detail = useLive<SessionDetail>(selected && !storage ? `/api/session/${selected}` : undefined, version)

  useEffect(() => {
    const onHash = () => setSelected(location.hash.slice(1) || undefined)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const select = (id?: string) => {
    location.hash = id ?? ''
    setSelected(id)
  }

  const sessions = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = overview?.sessions ?? []
    return q ? list.filter(s => `${s.title} ${s.projectName} ${s.cwd}`.toLowerCase().includes(q)) : list
  }, [overview, query])

  const [groupBy, setGroupBy] = useState<GroupBy>(() => remembered<GroupBy>('groupBy', 'project'))
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => remembered('collapsed', {}))
  const groups = useMemo(() => groupSessions(sessions, groupBy), [sessions, groupBy])
  const chooseGroup = (by: GroupBy) => {
    setGroupBy(by)
    remember('groupBy', by)
  }
  const toggle = (key: string) => {
    const next = { ...collapsed, [`${groupBy}:${key}`]: !collapsed[`${groupBy}:${key}`] }
    setCollapsed(next)
    remember('collapsed', next)
  }
  // While filtering, every group is open so no match hides in a collapsed one.
  const isOpen = (key: string) => query.trim() !== '' || !collapsed[`${groupBy}:${key}`]

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => select(undefined)} title="Overview of all sessions">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
            <path d="M16 2l12 7v14l-12 7-12-7V9z" fill={C.honey} />
            <circle cx="16" cy="16" r="5" fill={C.bg} />
          </svg>
          <span>Hivescope</span>
        </button>
        {overview && <Kpis overview={overview} />}
        <button className={`top-btn ${storage ? 'on' : ''}`} onClick={() => select(storage ? undefined : 'storage')} title="Free the disk space agents left behind">
          {measuring ? <span className="spinner" aria-label="Measuring" /> : '▣'} Free space
        </button>
        <NotificationsButton />
        <UpdateButton />
        <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Receiving live updates' : 'Not connected to the Hivescope server'}>
          {connected ? 'live' : 'offline'}
        </span>
      </header>

      <aside className="side">
        <input className="search" placeholder="Filter sessions…" value={query} onChange={e => setQuery(e.target.value)} />
        <button className={`side-all ${selected ? '' : 'active'}`} onClick={() => select(undefined)}>
          All sessions
          <span className="count">{overview?.sessions.length ?? 0}</span>
        </button>
        <div className="group-by" role="radiogroup" aria-label="Group sessions by">
          <span>Group by</span>
          {(Object.keys(GROUP_LABELS) as GroupBy[]).map(by => (
            <button key={by} role="radio" aria-checked={groupBy === by} className={groupBy === by ? 'on' : ''} onClick={() => chooseGroup(by)}>
              {GROUP_LABELS[by]}
            </button>
          ))}
        </div>
        <div className="cards">
          {groups.map(g => {
            const open = isOpen(g.key)
            const cards = g.sessions.map(s => <SessionCard key={s.id} s={s} active={s.id === selected} onClick={() => select(s.id)} />)
            if (groupBy === 'none') return cards
            return (
              <section key={g.key} className="group">
                <button className="group-h" onClick={() => toggle(g.key)} aria-expanded={open} title={g.hint}>
                  <span className={`chev ${open ? 'open' : ''}`} aria-hidden>
                    ▸
                  </span>
                  <span className="group-name">{g.label}</span>
                  {g.live > 0 && <span className="group-live" title={`${g.live} live`} />}
                  <span className="group-count">{g.sessions.length}</span>
                </button>
                {open && <div className="group-cards">{cards}</div>}
              </section>
            )
          })}
          {overview && sessions.length === 0 && <p className="empty">No sessions match.</p>}
        </div>
        {overview && (
          <p className="foot">
            {overview.scan.files === 0
              ? 'Reading your transcripts…'
              : `Last ${overview.windowDays} days · ${overview.scan.files} files · ${tokens(overview.scan.bytes).replace(/([kMB])$/, s => ({ k: ' KB', M: ' MB', B: ' GB' })[s]!)} read`}
          </p>
        )}
      </aside>

      <main className="main">
        {!overview && <p className="empty big">Reading your transcripts…</p>}
        {overview && !selected && <OverviewView overview={overview} onOpen={select} />}
        {storage && <SpaceView onOpen={select} onScanning={setMeasuring} />}
        {selected && !storage && !detail && <p className="empty big">Loading session…</p>}
        {selected && !storage && detail && <SessionView s={detail} />}
      </main>
    </div>
  )
}

function Kpis({ overview }: { overview: Overview }) {
  const live = overview.sessions.filter(s => s.status === 'live').length
  const running = overview.sessions.reduce((n, s) => n + s.subagentsRunning, 0)
  const today = dayOf(Date.now())
  const outToday = overview.daily.filter(d => d.day === today).reduce((n, d) => n + d.output, 0)
  const advisor = overview.advisorCount
  const waiting = overview.sessions.filter(s => s.waiting).length
  const items: [string, string, string][] = [
    ['Waiting for you', String(waiting), waiting ? C.honey : C.dim],
    ['Live sessions', String(live), live ? C.done : C.dim],
    ['Subagents running', String(running), running ? C.sonnet : C.dim],
    [`Advisor calls · ${overview.windowDays}d`, String(advisor), C.opus],
    ['Output today', tokens(outToday), C.text],
  ]
  return (
    <div className="kpis">
      {items.map(([label, value, color]) => (
        <div className="kpi" key={label}>
          <span className="kpi-v" style={{ color }}>
            {value}
          </span>
          <span className="kpi-l">{label}</span>
        </div>
      ))}
    </div>
  )
}

function SessionCard({ s, active, onClick }: { s: SessionSummary; active: boolean; onClick: () => void }) {
  return (
    <button className={`card ${active ? 'active' : ''} ${s.status} ${s.waiting ? 'waiting' : ''}`} onClick={onClick}>
      <div className="card-top">
        <span className={`dot ${s.status}`} />
        <span className="card-title">{s.title}</span>
      </div>
      <div className="card-meta">
        <span style={{ color: modelColor(s.mainModel) }}>{shortModel(s.mainModel)}</span>
        <span>·</span>
        <span className="mono">{s.projectName}</span>
        <span className="grow" />
        <span>{ago(s.lastAt)}</span>
      </div>
      <div className="card-stats">
        <span title="Tool calls">⚒ {s.toolCalls}</span>
        {s.subagentsTotal > 0 && (
          <span title="Subagents (running/total)" style={{ color: s.subagentsRunning ? C.sonnet : undefined }}>
            ⬡ {s.subagentsRunning}/{s.subagentsTotal}
          </span>
        )}
        {s.advisorCalls > 0 && (
          <span title="Advisor calls" style={{ color: C.opus }}>
            ◆ {s.advisorCalls}
          </span>
        )}
        {s.waiting && (
          <span className="wait-badge" title={`Waiting for you: ${s.waiting.text}`}>
            ✋ waiting
          </span>
        )}
        {s.talks > 0 && (
          <span title="Messages with other Claude sessions" style={{ color: C.honey }}>
            ⇄ {s.talks}
          </span>
        )}
        {s.contextTokens / contextWindow(s.mainModel) >= COMPACT_AT && (
          <span className="ctx-badge" title="Context is past 40%: compact this session">
            ⚑ {Math.round((100 * s.contextTokens) / contextWindow(s.mainModel))}%
          </span>
        )}
        {s.errors > 0 && (
          <span title="Tool errors" style={{ color: C.error }}>
            ✕ {s.errors}
          </span>
        )}
        <span className="grow" />
        <span title="Output tokens">{tokens(s.outputTokens)}</span>
      </div>
      {s.status === 'live' && s.lastAction && <div className="card-last">{s.lastAction}</div>}
      <div className="card-bar" style={{ background: C[family(s.mainModel)] }} />
    </button>
  )
}
