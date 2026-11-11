import { useCallback, useEffect, useState } from 'react'

import { type FileStat, LEFTOVER_KINDS, type LeftoverKind, type SpaceReport, type SpaceSession } from '../../shared/types'
import { confirmAction } from './Confirm'
import { size } from './Shots'
import { ago } from './theme'

const KIND: Record<LeftoverKind, { label: string; short: string; what: string }> = {
  tasks: {
    label: 'Background task output',
    short: 'Task output',
    what: 'What commands an agent ran in the background printed: dev servers, builds, test runs. Only read while that command runs.',
  },
  scratchpad: {
    label: 'Scratchpad files',
    short: 'Scratchpad',
    what: 'Temporary files agents wrote while working: helper scripts, notes, downloads and images. Not part of the chat.',
  },
  screenshots: {
    label: 'Tool screenshots',
    short: 'Screenshots',
    what: 'Copies of the screenshots browser and screen-control tools took.',
  },
}

async function free(body: { kinds: LeftoverKind[]; sessionId?: string }) {
  const res = await fetch('/api/space/free', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hivescope': 'delete' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Freeing failed (${res.status})`)
  return (await res.json()) as { deleted: number; bytes: number; skipped: number; held: number }
}

const sum = (stats: FileStat[]): FileStat => stats.reduce((a, b) => ({ files: a.files + b.files, bytes: a.bytes + b.bytes }), { files: 0, bytes: 0 })

/** What agents left on disk, how much of it can go now, and freeing it. */
export function SpaceView({ onOpen, onScanning }: { onOpen: (id: string) => void; onScanning?: (scanning: boolean) => void }) {
  const [report, setReport] = useState<SpaceReport>()
  const [scanning, setScanning] = useState(true)
  const [chosen, setChosen] = useState<Record<LeftoverKind, boolean>>({ tasks: true, scratchpad: true, screenshots: true })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  // Scanned when the view opens and after freeing, not on every live update: it walks gigabytes.
  const scan = useCallback(() => {
    setScanning(true)
    fetch('/api/space')
      .then(r => (r.ok ? (r.json() as Promise<SpaceReport>) : undefined))
      .then(r => r && setReport(r))
      .catch(() => {})
      .finally(() => setScanning(false))
  }, [])
  useEffect(scan, [scan])
  // The top bar's Free space button shows the same loading state; cleared when the view closes.
  useEffect(() => onScanning?.(scanning), [scanning, onScanning])
  useEffect(() => () => onScanning?.(false), [onScanning])

  const header = (
    <>
      <header className="panel-h">
        <h2>Free space</h2>
        <span className="panel-note">what agents left behind on this PC · every session, not only the last 7 days</span>
        <span className="grow" />
        {scanning && (
          <span className="space-loading" role="status">
            <span className="spinner" aria-hidden />
            {report ? 'Measuring again…' : 'Measuring…'}
          </span>
        )}
        <button className="btn" onClick={scan} disabled={scanning || busy}>
          Measure again
        </button>
      </header>
      <div className={`space-progress ${scanning ? 'on' : ''}`} aria-hidden />
    </>
  )

  if (!report) {
    return (
      <div className="grid">
        <section className="panel wide">
          {header}
          <div className="space-hero">
            <span className="skeleton" style={{ width: 260, height: 34 }} />
          </div>
          <div className="space-kinds">
            {LEFTOVER_KINDS.map(k => (
              <div key={k} className="space-kind on">
                <span className="space-kind-body">
                  <b>{KIND[k].label}</b>
                  <span className="dim small">{KIND[k].what}</span>
                  <span className="skeleton" style={{ width: 90, height: 14 }} />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    )
  }

  const kinds = LEFTOVER_KINDS.filter(k => chosen[k])
  const freeOf = (s: SpaceSession) => sum(kinds.map(k => s.free[k]))
  const total = sum(kinds.map(k => report.totals[k].free))
  const everything = sum(LEFTOVER_KINDS.map(k => report.totals[k].free))
  const heldTotal = sum(LEFTOVER_KINDS.map(k => report.totals[k].held))
  const max = Math.max(1, ...report.sessions.map(s => sum(LEFTOVER_KINDS.map(k => s.free[k])).bytes))
  const names = kinds.map(k => KIND[k].label.toLowerCase()).join(', ')

  const run = async (body: { kinds: LeftoverKind[]; sessionId?: string }, stat: FileStat, where: string) => {
    const ok = await confirmAction({
      title: `Delete ${stat.files} files?`,
      details: [`${size(stat.bytes)} of ${names}, ${where}.`, 'Files a running session is still using are kept.'],
      warning: 'They are deleted permanently, not moved to the Recycle Bin.',
      action: `Delete ${stat.files} files`,
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await free(body)
      const extra = [r.held && `${r.held} kept for now, still in use`, r.skipped && `${r.skipped} skipped, open in another program`].filter(Boolean).join('; ')
      setMessage(`Freed ${size(r.bytes)} (${r.deleted} files)${extra ? `. ${extra}.` : '.'}`)
    } catch (err) {
      setMessage(String(err))
    }
    setBusy(false)
    scan()
  }

  return (
    <div className="grid">
      <section className="panel wide">
        {header}

        <div className="space-hero">
          {everything.files > 0 ? (
            <div>
              <span className="space-big">{size(everything.bytes)}</span>
              <span className="dim"> can be freed safely · {everything.files} files</span>
            </div>
          ) : (
            <div>
              <span className="space-big">Nothing to free</span>
              <span className="dim"> right now</span>
            </div>
          )}
          {heldTotal.files > 0 && (
            <p className="dim small">
              {size(heldTotal.bytes)} more is kept for now: it belongs to a live session, or a session or file touched in the last {report.quietHours} hours.
            </p>
          )}
        </div>

        <div className="space-kinds">
          {LEFTOVER_KINDS.map(k => {
            const t = report.totals[k]
            return (
              <label key={k} className={`space-kind ${chosen[k] ? 'on' : ''}`}>
                <input type="checkbox" checked={chosen[k]} onChange={e => setChosen({ ...chosen, [k]: e.target.checked })} />
                <span className="space-kind-body">
                  <span className="space-kind-h">
                    <b>{KIND[k].label}</b>
                    <span className="space-kind-v">{size(t.free.bytes)}</span>
                  </span>
                  <span className="dim small">{KIND[k].what}</span>
                  <span className="space-kind-n">
                    {t.free.files} files{t.held.files > 0 && ` · ${size(t.held.bytes)} kept for now`}
                  </span>
                </span>
              </label>
            )
          })}
        </div>

        <div className="storage-actions">
          <span className="dim small">
            Never touched: your chats (transcripts), images you pasted, edit history and anything outside these three folders.
          </span>
          <span className="grow" />
          {message && <span className="dim">{message}</span>}
          <button className="btn danger big" disabled={busy || scanning || total.files === 0} onClick={() => run({ kinds }, total, `from ${report.sessions.length} sessions`)}>
            Free {size(total.bytes)}
          </button>
        </div>

        <details className="why space-why">
          <summary>Why this is safe</summary>
          <ul>
            <li>
              <b>Nothing in the chat depends on it.</b> Your conversation, and what <code>/resume</code> reads back, lives in the transcript, which stays.
            </li>
            <li>
              <b>Active work is left alone.</b> A live session, a session used in the last {report.quietHours} hours, and any file written in that time are kept,
              so a dev server still writing its log keeps it.
            </li>
            <li>
              <b>Only those three folders.</b> Hivescope lists the files again when you click, inside session folders only, and never follows a link or junction out of
              them. Files another program has open are skipped.
            </li>
            <li>
              <b>The trade-off.</b> If you go back to an old session, the agent can't reopen a scratch file or log it made there. It can make it again.
            </li>
          </ul>
        </details>
      </section>

      <section className="panel wide">
        <header className="panel-h">
          <h2>By session</h2>
          <span className="panel-note">largest first</span>
        </header>
        {report.sessions.length === 0 ? (
          <p className="empty">Agents left nothing behind.</p>
        ) : (
          <table className="table storage">
            <thead>
              <tr>
                <th>Session</th>
                <th>Size</th>
                {LEFTOVER_KINDS.map(k => (
                  <th key={k} className="num">
                    {KIND[k].short}
                  </th>
                ))}
                <th>Kept for now</th>
                <th>Last written</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.sessions.map(s => {
                const pick = freeOf(s)
                const all = sum(LEFTOVER_KINDS.map(k => s.free[k]))
                return (
                  <tr key={s.sessionId}>
                    <td>
                      {s.title ? (
                        <button className="link" onClick={() => onOpen(s.sessionId)} title="Open this session">
                          {s.title}
                        </button>
                      ) : (
                        <span className="dim" title="Older than the last 7 days, or its transcript is gone">
                          older session {s.sessionId.slice(0, 8)}
                        </span>
                      )}
                      {s.projectName && <span className="dim mono"> · {s.projectName}</span>}
                      {s.live && <span className="pill run inline">live</span>}
                    </td>
                    <td className="bar-cell">
                      <span className="size-bar" style={{ width: `${(100 * all.bytes) / max}%` }} />
                      <span>{size(all.bytes)}</span>
                    </td>
                    {LEFTOVER_KINDS.map(k => (
                      <td key={k} className="num dim">
                        {s.free[k].files ? size(s.free[k].bytes) : '–'}
                      </td>
                    ))}
                    <td className="dim">{s.held.files ? size(s.held.bytes) : '–'}</td>
                    <td className="dim">{ago(s.lastAt)}</td>
                    <td className="num">
                      <button
                        className="btn danger small"
                        disabled={busy || scanning || pick.files === 0}
                        onClick={() => run({ kinds, sessionId: s.sessionId }, pick, `from "${s.title ?? s.sessionId.slice(0, 8)}"`)}
                      >
                        Free · {size(pick.bytes)}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
