import type { AdvisorCall, LogEvent } from '../../shared/types'
import { C, ago, hms, modelColor } from './theme'

export function Panel({ title, note, children, wide }: { title: string; note?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`panel ${wide ? 'wide' : ''}`}>
      <header className="panel-h">
        <h2>{title}</h2>
        {note && <span className="panel-note">{note}</span>}
      </header>
      {children}
    </section>
  )
}

const KIND_COLOR: Partial<Record<LogEvent['kind'], string>> = {
  'agent-done': C.done,
  advisor: C.opus,
  error: C.error,
}

export function LiveLog({ events, onOpen, max = 120 }: { events: LogEvent[]; onOpen?: (id: string) => void; max?: number }) {
  const shown = events.slice(-max).reverse()
  if (shown.length === 0) return <p className="empty">Waiting for activity…</p>
  return (
    <ol className="log">
      {shown.map((e, i) => (
        <li key={`${e.at}-${i}`} className={`log-row ${e.kind}`}>
          <span className="mono dim">{hms(e.at)}</span>
          <span className="who" style={{ color: KIND_COLOR[e.kind] ?? modelColor(e.model) }}>
            {e.kind === 'advisor' ? 'advisor' : e.who}
          </span>
          <span className="what">{e.text}</span>
          {onOpen && (
            <button className="jump" onClick={() => onOpen(e.sessionId)} title="Open this session">
              ↗
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}

export function AdvisorFeed({ calls, onOpen, titles }: { calls: AdvisorCall[]; onOpen?: (id: string) => void; titles?: Map<string, string> }) {
  if (calls.length === 0) return <p className="empty">The advisor hasn't been consulted in this window.</p>
  return (
    <ul className="advice">
      {calls.map((a, i) => (
        <li key={`${a.at}-${i}`}>
          <div className="advice-h">
            <span className="diamond">◆</span>
            <span className="mono dim">{hms(a.at)}</span>
            <span className="dim">{a.who === 'main' ? 'main session' : a.who}</span>
            {titles && (
              <button className="link" onClick={() => onOpen?.(a.sessionId)}>
                {titles.get(a.sessionId) ?? a.sessionId.slice(0, 8)}
              </button>
            )}
            <span className="grow" />
            <span className="dim">{ago(a.at)}</span>
          </div>
          <p className="advice-on">{a.about}</p>
        </li>
      ))}
    </ul>
  )
}

export function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat">
      <span className="stat-v" style={{ color }}>
        {value}
      </span>
      <span className="stat-l">{label}</span>
    </div>
  )
}
