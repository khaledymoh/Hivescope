import { useEffect, useRef, useState } from 'react'

/** What a confirmation asks. */
export interface ConfirmOptions {
  title: string
  /** Lines under the title: what will happen, and anything to watch out for. */
  details: string[]
  /** The button that goes ahead, e.g. "Delete 12 files". */
  action: string
  /** A warning line shown in red, such as "This can't be undone". */
  warning?: string
  /** A change that is easy to undo: the button isn't drawn as a danger. */
  safe?: boolean
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void }
let show: ((p: Pending) => void) | undefined

/**
 * Asks before something that can't be taken back. Resolves true only when the action button is
 * clicked; Escape, Cancel or a click outside resolve false. Needs <ConfirmHost /> on the page.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    if (!show) return resolve(window.confirm(`${options.title}\n\n${options.details.join('\n')}`))
    show({ ...options, resolve })
  })
}

/** Renders the confirmation dialog when one is asked for. Mount once, at the root. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending>()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    show = p => setPending(p)
    return () => {
      show = undefined
    }
  }, [])

  const close = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(undefined)
  }

  useEffect(() => {
    if (!pending) return
    // Cancel has the focus, so Enter never deletes by accident.
    cancelRef.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(false)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  if (!pending) return null
  return (
    <div className="confirm-backdrop" onClick={() => close(false)}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={e => e.stopPropagation()}>
        <h2 id="confirm-title">{pending.title}</h2>
        {pending.details.map(line => (
          <p key={line}>{line}</p>
        ))}
        {pending.warning && <p className="confirm-warning">{pending.warning}</p>}
        <div className="confirm-buttons">
          <button ref={cancelRef} className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button className={pending.safe ? 'btn primary' : 'btn danger solid'} onClick={() => close(true)}>
            {pending.action}
          </button>
        </div>
      </div>
    </div>
  )
}
