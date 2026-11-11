import { useCallback, useEffect, useState } from 'react'

import type { ShotFile, ShotKind } from '../../shared/types'
import { Panel } from './parts'
import { hms } from './theme'

const KIND_LABEL: Record<ShotKind, string> = {
  tool: 'Tool screenshots',
  scratchpad: 'Saved by agents',
  pasted: 'Pasted by you',
  opened: 'Opened from your files',
}
const KIND_HINT: Record<ShotKind, string> = {
  tool: 'Browser, screen control and other tools',
  scratchpad: 'Images agents saved in their scratchpad',
  pasted: 'Images you pasted into the chat',
  opened: 'Saved outside Claude’s folders, such as in your project, and opened by Claude. Shown only: Hivescope never deletes them',
}

export function size(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function remove(body: { ids?: string[]; sessionId?: string; all?: boolean; includePasted?: boolean }) {
  const res = await fetch('/api/shots/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hivescope': 'delete' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Delete failed (${res.status})`)
  return (await res.json()) as { deleted: number; bytes: number; skipped: number }
}

function useJson<T>(url: string): [T | undefined, () => void] {
  const [data, setData] = useState<T>()
  const [n, setN] = useState(0)
  useEffect(() => {
    let off = false
    fetch(url)
      .then(r => (r.ok ? r.json() : undefined))
      .then(d => !off && setData(d as T))
      .catch(() => {})
    return () => {
      off = true
    }
  }, [url, n])
  return [data, useCallback(() => setN(x => x + 1), [])]
}

/** A full-size view of one image, with delete and previous/next. */
function Lightbox({ files, index, onIndex, onDelete, onClose }: { files: ShotFile[]; index: number; onIndex: (i: number) => void; onDelete: (f: ShotFile) => void; onClose: () => void }) {
  const f = files[index]
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && index < files.length - 1) onIndex(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [index, files.length, onIndex, onClose])
  if (!f) return null
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={f.name}>
      <div className="lightbox-bar" onClick={e => e.stopPropagation()}>
        <span className="mono">{f.name}</span>
        <span className="dim">
          {KIND_LABEL[f.kind]} · {size(f.bytes)} · {hms(f.at)} · {index + 1}/{files.length}
        </span>
        <span className="grow" />
        <button className="btn" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          ← Prev
        </button>
        <button className="btn" disabled={index === files.length - 1} onClick={() => onIndex(index + 1)}>
          Next →
        </button>
        {f.kind !== 'opened' && (
          <button className="btn danger" onClick={() => onDelete(f)}>
            Delete
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <img src={`/api/shot/${f.id}`} alt={f.name} onClick={e => e.stopPropagation()} />
    </div>
  )
}

/** One session's screenshots: thumbnails by kind, full view, delete one or all. */
export function ShotGallery({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [files, reload] = useJson<ShotFile[]>(`/api/shots/${sessionId}`)
  const [open, setOpen] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  if (!files) return <Panel title="Screenshots" wide><p className="empty">Looking for screenshots…</p></Panel>
  const agentFiles = files.filter(f => f.kind === 'tool' || f.kind === 'scratchpad')
  const total = files.reduce((n, f) => n + f.bytes, 0)
  const agentBytes = agentFiles.reduce((n, f) => n + f.bytes, 0)

  const deleteOne = async (f: ShotFile) => {
    if (!confirm(`Delete ${f.name} (${size(f.bytes)})? This can't be undone.`)) return
    await remove({ ids: [f.id], includePasted: f.kind === 'pasted' })
    setOpen(undefined)
    reload()
  }
  const deleteAll = async () => {
    const warn = live ? '\n\nThis session is live: an agent may still need a screenshot it just saved.' : ''
    if (!confirm(`Delete ${agentFiles.length} agent screenshots (${size(agentBytes)}) from this session? Images you pasted are kept. This can't be undone.${warn}`)) return
    setBusy(true)
    try {
      const r = await remove({ sessionId })
      setMessage(`Deleted ${r.deleted} screenshots, freed ${size(r.bytes)}.`)
    } catch (err) {
      setMessage(String(err))
    }
    setBusy(false)
    reload()
  }

  return (
    <Panel title="Screenshots" note={files.length ? `${files.length} images · ${size(total)}` : 'none in this session'} wide>
      {files.length === 0 ? (
        <p className="empty">No screenshots or images saved for this session.</p>
      ) : (
        <>
          <div className="shots-actions">
            {message && <span className="dim">{message}</span>}
            <span className="grow" />
            {agentFiles.length > 0 && (
              <button className="btn danger" disabled={busy} onClick={deleteAll}>
                Delete {agentFiles.length} agent screenshots · {size(agentBytes)}
              </button>
            )}
          </div>
          {(['scratchpad', 'tool', 'opened', 'pasted'] as ShotKind[]).map(kind => {
            const group = files.filter(f => f.kind === kind)
            if (group.length === 0) return null
            const folders = [...new Set(group.map(f => f.path?.replace(/[\\/][^\\/]*$/, '')).filter(Boolean))]
            return (
              <section key={kind} className="shots-group">
                <h3>
                  {KIND_LABEL[kind]} <span className="dim">· {group.length} · {size(group.reduce((n, f) => n + f.bytes, 0))} · {KIND_HINT[kind]}</span>
                </h3>
                {folders.length > 0 && (
                  <p className="shots-where mono" title="Where these files are">
                    {folders.slice(0, 3).join(' · ')}
                    {folders.length > 3 && ` · +${folders.length - 3} more`}
                  </p>
                )}
                <div className="shots-grid">
                  {group.map(f => (
                    <div key={f.id} className="shot">
                      <button className="shot-img" onClick={() => setOpen(files.indexOf(f))} title={`${f.name} · ${size(f.bytes)}`}>
                        <img src={`/api/shot/${f.id}`} alt={f.name} loading="lazy" decoding="async" />
                      </button>
                      <div className="shot-meta">
                        <span className="shot-name">{f.name}</span>
                        <span className="dim">{size(f.bytes)}</span>
                        {f.kind !== 'opened' && (
                          <button className="shot-del" onClick={() => deleteOne(f)} aria-label={`Delete ${f.name}`} title="Delete">
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </>
      )}
      {open !== undefined && <Lightbox files={files} index={open} onIndex={setOpen} onDelete={deleteOne} onClose={() => setOpen(undefined)} />}
    </Panel>
  )
}
