import { useCallback, useEffect, useState } from 'react'

import type { ShotFile, ShotKind } from '../../shared/types'
import { confirmAction } from './Confirm'
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
const OPENED_HINT_TRASH = 'Saved outside Claude’s folders, such as in your project, and opened by Claude. Removing them moves them to the Recycle Bin'
const BIN = navigator.platform.startsWith('Mac') ? 'Trash' : 'Recycle Bin'

export function size(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function remove(body: { ids?: string[]; sessionId?: string; all?: boolean; includePasted?: boolean; includeOpened?: boolean }) {
  const res = await fetch('/api/shots/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hivescope': 'delete' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Delete failed (${res.status})`)
  return (await res.json()) as { deleted: number; bytes: number; skipped: number; trashed: number }
}

/** A session's images, and whether those opened from your folders can go to the Recycle Bin from here. */
function useShots(sessionId: string): [{ files: ShotFile[]; canTrash: boolean } | undefined, () => void] {
  const [data, setData] = useState<{ files: ShotFile[]; canTrash: boolean }>()
  const [n, setN] = useState(0)
  useEffect(() => {
    let off = false
    fetch(`/api/shots/${sessionId}`)
      .then(async r => (r.ok ? { files: (await r.json()) as ShotFile[], canTrash: r.headers.get('x-hivescope-trash') === '1' } : undefined))
      .then(d => !off && setData(d))
      .catch(() => {})
    return () => {
      off = true
    }
  }, [sessionId, n])
  return [data, useCallback(() => setN(x => x + 1), [])]
}


/** A full-size view of one image, with delete and previous/next. */
function Lightbox({
  files,
  index,
  canTrash,
  onIndex,
  onDelete,
  onClose,
}: {
  files: ShotFile[]
  index: number
  canTrash: boolean
  onIndex: (i: number) => void
  onDelete: (f: ShotFile) => void
  onClose: () => void
}) {
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
        {(f.kind !== 'opened' || canTrash) && (
          <button className="btn danger" onClick={() => onDelete(f)}>
            {f.kind === 'opened' ? `Move to ${BIN}` : 'Delete'}
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
  const [data, reload] = useShots(sessionId)
  const [open, setOpen] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  if (!data) return <Panel title="Screenshots" wide><p className="empty">Looking for screenshots…</p></Panel>
  const { files, canTrash } = data
  const agentFiles = files.filter(f => f.kind === 'tool' || f.kind === 'scratchpad')
  const openedFiles = files.filter(f => f.kind === 'opened')
  const total = files.reduce((n, f) => n + f.bytes, 0)
  const agentBytes = agentFiles.reduce((n, f) => n + f.bytes, 0)
  const liveWarning = live ? 'This session is live: an agent may still need an image it just saved.' : undefined
  const removable = (f: ShotFile) => f.kind !== 'opened' || canTrash

  const report = (r: { deleted: number; bytes: number; skipped: number; trashed: number }) => {
    const parts = [r.trashed && `moved ${r.trashed} to the ${BIN}`, r.deleted - r.trashed && `deleted ${r.deleted - r.trashed}`].filter(Boolean)
    setMessage(`${parts.join(', ').replace(/^./, c => c.toUpperCase())}: ${size(r.bytes)}${r.skipped ? `. ${r.skipped} skipped, in use or already gone.` : '.'}`)
  }
  const act = async (body: Parameters<typeof remove>[0]) => {
    setBusy(true)
    try {
      report(await remove(body))
    } catch (err) {
      setMessage(String(err))
    }
    setBusy(false)
    setOpen(undefined)
    reload()
  }

  const deleteOne = async (f: ShotFile) => {
    const toBin = f.kind === 'opened'
    const ok = await confirmAction(
      toBin
        ? {
            title: `Move ${f.name} to the ${BIN}?`,
            details: [`${size(f.bytes)}, in ${f.path?.replace(/[\\/][^\\/]*$/, '') ?? 'your files'}.`, `It's your file, not Claude's: you can restore it from the ${BIN}.`],
            action: `Move to ${BIN}`,
          }
        : {
            title: `Delete ${f.name}?`,
            details: [`${size(f.bytes)}, ${KIND_LABEL[f.kind].toLowerCase()}.`, ...(liveWarning ? [liveWarning] : [])],
            warning: 'It is deleted permanently, not moved to the Recycle Bin.',
            action: 'Delete',
          },
    )
    if (ok) await act({ ids: [f.id], includePasted: f.kind === 'pasted', includeOpened: toBin })
  }
  const deleteAgent = async () => {
    const ok = await confirmAction({
      title: `Delete ${agentFiles.length} agent screenshots?`,
      details: [`${size(agentBytes)} of tool screenshots and images agents saved in this session.`, 'Images you pasted and images in your own folders are kept.', ...(liveWarning ? [liveWarning] : [])],
      warning: 'They are deleted permanently, not moved to the Recycle Bin.',
      action: `Delete ${agentFiles.length} screenshots`,
    })
    if (ok) await act({ sessionId })
  }
  const trashOpened = async () => {
    const bytes = openedFiles.reduce((n, f) => n + f.bytes, 0)
    const folders = [...new Set(openedFiles.map(f => f.path?.replace(/[\\/][^\\/]*$/, '')).filter(Boolean))] as string[]
    const ok = await confirmAction({
      title: `Move ${openedFiles.length} images to the ${BIN}?`,
      details: [
        `${size(bytes)} of images in your own folders that this session opened:`,
        ...folders.slice(0, 4),
        ...(folders.length > 4 ? [`and ${folders.length - 4} more folders`] : []),
        `These are your files, not Claude's. You can restore them from the ${BIN}.`,
        ...(liveWarning ? [liveWarning] : []),
      ],
      action: `Move ${openedFiles.length} to ${BIN}`,
    })
    if (ok) await act({ ids: openedFiles.map(f => f.id), includeOpened: true })
  }

  return (
    <Panel title="Screenshots" note={files.length ? `${files.length} images · ${size(total)}` : 'none in this session'} wide>
      {files.length === 0 ? (
        <p className="empty">{message || 'No screenshots or images saved for this session.'}</p>
      ) : (
        <>
          <div className="shots-actions">
            {message && <span className="dim">{message}</span>}
            <span className="grow" />
            {agentFiles.length > 0 && (
              <button className="btn danger" disabled={busy} onClick={deleteAgent}>
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
                <h3 className="shots-group-h">
                  <span>
                    {KIND_LABEL[kind]}{' '}
                    <span className="dim">
                      · {group.length} · {size(group.reduce((n, f) => n + f.bytes, 0))} · {kind === 'opened' && canTrash ? OPENED_HINT_TRASH : KIND_HINT[kind]}
                    </span>
                  </span>
                  {kind === 'opened' && canTrash && (
                    <button className="btn danger small" disabled={busy} onClick={trashOpened}>
                      Move {group.length} to {BIN}
                    </button>
                  )}
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
                        {removable(f) && (
                          <button
                            className="shot-del"
                            onClick={() => deleteOne(f)}
                            aria-label={f.kind === 'opened' ? `Move ${f.name} to the ${BIN}` : `Delete ${f.name}`}
                            title={f.kind === 'opened' ? `Move to ${BIN}` : 'Delete'}
                          >
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
      {open !== undefined && <Lightbox files={files} index={open} canTrash={canTrash} onIndex={setOpen} onDelete={deleteOne} onClose={() => setOpen(undefined)} />}
    </Panel>
  )
}
