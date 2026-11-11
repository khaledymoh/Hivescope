import { useMemo, useState } from 'react'

import type { Overview, SessionLink, SessionSummary } from '../../shared/types'
import { Chart, tooltip } from './Chart'
import { Panel } from './parts'
import { C, ago, family, hms } from './theme'

const open = (id: string) => {
  location.hash = id
}

/** The other session's name as best known. */
function peerLabel(l: SessionLink): string {
  return l.peerTitle ?? l.peerName ?? (l.peerLocal ? `session ${l.peerLocal.slice(6, 14)}` : 'another session')
}
const peerKey = (l: SessionLink) => l.peerSessionId ?? l.peerName ?? l.peerLocal ?? l.peerAddress ?? '?'

function Peer({ l, onOpen = open }: { l: SessionLink; onOpen?: (id: string) => void }) {
  const name = peerLabel(l)
  return l.peerSessionId ? (
    <button className="link" onClick={() => onOpen(l.peerSessionId!)} title="Open that session">
      {name}
    </button>
  ) : (
    <b title="Its transcript is older than the window, or gone">{name}</b>
  )
}

const ICON: Record<SessionLink['kind'], string> = { sent: '→', received: '←', started: '✦', forked: '⑂' }

/** One exchange: who, which way, the summary and the message, expandable. */
function LinkRow({ l, from, to, onOpen }: { l: SessionLink; from?: React.ReactNode; to?: React.ReactNode; onOpen?: (id: string) => void }) {
  const [full, setFull] = useState(false)
  const long = l.text.length > 220 || l.text.includes('\n')
  let head: React.ReactNode
  if (l.kind === 'started') {
    const verb = l.initiation === 'hand-off' ? 'Handed its task to a new session' : l.initiation === 'user_asked' ? 'Started a session' : 'Proposed a session'
    head = (
      <>
        {from && <>{from} · </>}
        {from ? verb.toLowerCase() : verb} <Peer l={l} onOpen={onOpen} />
      </>
    )
  } else if (l.kind === 'forked') {
    head = (
      <>
        Forked from <Peer l={l} onOpen={onOpen} />
      </>
    )
  } else {
    head = from ? (
      <>
        {from} → <Peer l={l} onOpen={onOpen} />
      </>
    ) : to ? (
      <>
        <Peer l={l} onOpen={onOpen} /> → {to}
      </>
    ) : (
      <>
        {l.kind === 'sent' ? 'To' : 'From'} <Peer l={l} onOpen={onOpen} />
      </>
    )
  }
  return (
    <li className={`talk-row ${l.kind} ${l.ok === false ? 'failed' : ''}`}>
      <span className="talk-icon" aria-hidden>
        {ICON[l.kind]}
      </span>
      <div className="talk-body">
        <div className="talk-head">
          <span>{head}</span>
          {l.ok === false && <span className="pill err">not delivered</span>}
          <span className="grow" />
          <span className="dim mono" title={new Date(l.at).toLocaleString()}>
            {hms(l.at)} · {ago(l.at)}
          </span>
        </div>
        {l.summary && <div className="talk-summary">{l.summary}</div>}
        {l.text && (
          <p className={`talk-text ${full ? 'full' : ''}`} onClick={() => long && setFull(!full)} title={long && !full ? 'Show all' : undefined}>
            {l.text}
          </p>
        )}
        {long && (
          <button className="talk-more" onClick={() => setFull(!full)}>
            {full ? 'Show less' : 'Show all'}
          </button>
        )}
        {l.error && <p className="talk-error">{l.error}</p>}
      </div>
    </li>
  )
}

/** A session's exchanges with other Claude sessions: who it talked to, and the thread. */
export function TalkPanel({ links }: { links: SessionLink[] }) {
  const [only, setOnly] = useState<string>()
  const peers = useMemo(() => {
    const by = new Map<string, { key: string; link: SessionLink; sent: number; received: number; other: number; lastAt: number }>()
    for (const l of links) {
      const key = peerKey(l)
      const p = by.get(key) ?? { key, link: l, sent: 0, received: 0, other: 0, lastAt: 0 }
      if (l.peerSessionId) p.link = l
      if (l.kind === 'sent') p.sent++
      else if (l.kind === 'received') p.received++
      else p.other++
      p.lastAt = Math.max(p.lastAt, l.at)
      by.set(key, p)
    }
    return [...by.values()].sort((a, b) => b.lastAt - a.lastAt)
  }, [links])
  if (links.length === 0) return null
  const shown = links.filter(l => !only || peerKey(l) === only).slice().reverse()
  const sent = links.filter(l => l.kind === 'sent').length
  const received = links.filter(l => l.kind === 'received').length

  return (
    <Panel title="Other sessions" note={`${sent} sent · ${received} received · newest first · who asked what, and what came back`} wide>
      <div className="talk-peers">
        {peers.map(p => (
          <button key={p.key} className={`talk-peer ${only === p.key ? 'on' : ''}`} onClick={() => setOnly(only === p.key ? undefined : p.key)} title="Show only this session">
            <span className="talk-peer-name">{peerLabel(p.link)}</span>
            <span className="talk-peer-n">
              {p.sent > 0 && <span title="Sent to it">→ {p.sent}</span>}
              {p.received > 0 && <span title="Received from it">← {p.received}</span>}
              {p.other > 0 && <span title="Started or forked">✦ {p.other}</span>}
            </span>
          </button>
        ))}
        {only && (
          <button className="talk-peer clear" onClick={() => setOnly(undefined)}>
            Show all
          </button>
        )}
      </div>
      <ol className="talk-list scroll tall">
        {shown.map((l, i) => (
          <LinkRow key={`${l.at}-${i}`} l={l} />
        ))}
      </ol>
    </Panel>
  )
}

/** Which sessions talk to which: a graph, and the newest messages. */
export function TalkOverview({ overview, onOpen }: { overview: Overview; onOpen: (id: string) => void }) {
  const byId = useMemo(() => new Map(overview.sessions.map(s => [s.id, s])), [overview.sessions])
  const option = useMemo(() => {
    const ids = [...new Set(overview.edges.flatMap(e => [e.from, e.to]))]
    const total = (id: string) => overview.edges.filter(e => e.from === id || e.to === id).reduce((n, e) => n + e.count, 0)
    const max = Math.max(1, ...ids.map(total))
    const name = (id: string) => byId.get(id)?.title ?? id.slice(0, 8)
    const byPair = new Map<string, { a: string; b: string; ab: number; ba: number }>()
    for (const e of overview.edges) {
      const [a, b] = [e.from, e.to].sort() as [string, string]
      const p = byPair.get(`${a}|${b}`) ?? { a, b, ab: 0, ba: 0 }
      if (e.from === a) p.ab += e.count
      else p.ba += e.count
      byPair.set(`${a}|${b}`, p)
    }
    const pairs = [...byPair.values()]
    return {
      tooltip: {
        ...tooltip,
        formatter: (p: unknown) => {
          const d = (p as { data: { id?: string; source?: string; target?: string; ab?: number; ba?: number } }).data
          if (d.source) {
            const line = (from: string, to: string, n = 0) => (n ? `${name(from)} → ${name(to)}: <b>${n}</b>` : '')
            return [line(d.source, d.target!, d.ab), line(d.target!, d.source, d.ba)].filter(Boolean).join('<br/>')
          }
          return `${name(d.id!)}<br/>${total(d.id!)} messages · click to open`
        },
      },
      series: [
        {
          id: 'talk',
          type: 'graph' as const,
          layout: 'circular' as const,
          circular: { rotateLabel: false },
          roam: false,
          top: 30,
          bottom: 30,
          left: 140,
          right: 140,
          edgeSymbolSize: 10,
          label: { show: true, position: 'right' as const, distance: 8, color: C.text, fontSize: 12.5, width: 170, overflow: 'truncate' as const },
          edgeLabel: {
            show: true,
            color: C.text,
            fontSize: 12,
            fontWeight: 600,
            backgroundColor: C.panel,
            padding: [2, 5],
            borderRadius: 4,
            formatter: (p: unknown) => {
              const d = (p as { data: { ab: number; ba: number } }).data
              return String(d.ab + d.ba)
            },
          },
          lineStyle: { color: C.dim, opacity: 0.8, curveness: 0.15 },
          emphasis: { focus: 'adjacency' as const, lineStyle: { width: 4 } },
          data: ids.map(id => {
            const s: SessionSummary | undefined = byId.get(id)
            return {
              id,
              name: name(id),
              symbolSize: 18 + 26 * (total(id) / max),
              itemStyle: { color: C[family(s?.mainModel)], borderColor: s?.status === 'live' ? C.done : C.bg, borderWidth: 2 },
            }
          }),
          // One line per pair; an arrowhead at each end that received messages.
          links: pairs.map(p => ({
            source: p.a,
            target: p.b,
            value: p.ab + p.ba,
            ab: p.ab,
            ba: p.ba,
            symbol: [p.ba ? 'arrow' : 'none', p.ab ? 'arrow' : 'none'],
            lineStyle: { width: 1.5 + 5 * Math.min(1, (p.ab + p.ba) / 60) },
          })),
        },
      ],
    }
  }, [overview.edges, byId])

  if (overview.messages.length === 0) return null
  const sender = (id: string) =>
    byId.has(id) ? (
      <button className="link" onClick={() => onOpen(id)}>
        {byId.get(id)!.title}
      </button>
    ) : (
      <b>{id.slice(0, 8)}</b>
    )

  return (
    <>
      {overview.edges.length > 0 && (
        <Panel title="Sessions talking" note={`messages between sessions, last ${overview.windowDays} days · arrows point to who received · hover a line for each direction · click a session to open it`}>
          <Chart option={option} height={300} onClick={d => (d as { id?: string }).id && onOpen((d as { id: string }).id)} />
        </Panel>
      )}
      <Panel title="Between sessions" note="who asked what, and what came back · newest first">
        <ol className="talk-list scroll">
          {overview.messages.map((m, i) => (
            <LinkRow key={`${m.at}-${i}`} l={m} from={m.kind === 'received' ? undefined : sender(m.sessionId)} to={m.kind === 'received' ? sender(m.sessionId) : undefined} onOpen={onOpen} />
          ))}
        </ol>
      </Panel>
    </>
  )
}
