import { useEffect, useRef, useState } from 'react'

import type { DesktopBridge, UpdateState } from '../../shared/update'

declare global {
  interface Window {
    /** Set by the desktop app's preload; absent when the page is open in a browser. */
    hivescopeDesktop?: DesktopBridge
  }
}

/**
 * The top bar's update button, in the desktop app only. It checks on its own, downloads a newer
 * version in the background and then offers "Restart to update", which installs it without a wizard.
 */
export function UpdateButton() {
  const bridge = window.hivescopeDesktop?.update
  const [state, setState] = useState<UpdateState>()
  const [upToDate, setUpToDate] = useState(false)
  const asked = useRef(false)

  useEffect(() => {
    if (!bridge) return
    void bridge.state().then(setState)
    return bridge.onChange(next => {
      setState(next)
      // "Up to date" for a few seconds after a check the user asked for.
      if (asked.current && next.status !== 'checking') {
        asked.current = false
        if (next.status === 'idle') {
          setUpToDate(true)
          setTimeout(() => setUpToDate(false), 4000)
        }
      }
    })
  }, [bridge])

  if (!bridge || !state || state.status === 'disabled') return null

  const check = () => {
    asked.current = true
    void bridge.check()
  }

  switch (state.status) {
    case 'idle':
      return (
        <button className="top-btn" onClick={check} title={`Hivescope ${state.version}${state.checkedAt ? ` · checked ${new Date(state.checkedAt).toLocaleTimeString()}` : ''} · Check for updates`}>
          {upToDate ? '✓ Up to date' : `↻ v${state.version}`}
        </button>
      )
    case 'checking':
      return (
        <button className="top-btn" disabled title="Checking GitHub for a newer Hivescope">
          <span className="spinner" aria-hidden /> Checking…
        </button>
      )
    case 'downloading': {
      const pct = state.total ? Math.min(100, Math.round((100 * state.received) / state.total)) : 0
      return (
        <button className="top-btn" disabled title={`Downloading Hivescope ${state.next}`}>
          <span className="spinner" aria-hidden /> Updating {pct}%
        </button>
      )
    }
    case 'ready':
      return (
        <button className="top-btn update-ready" onClick={() => void bridge.install()} title={`Hivescope ${state.next} is downloaded. Restarting installs it and opens it again.`}>
          ⬆ Restart to update {state.next}
        </button>
      )
    case 'installing':
      return (
        <button className="top-btn update-ready" disabled>
          <span className="spinner" aria-hidden /> Restarting…
        </button>
      )
    case 'error':
      return (
        <button className="top-btn update-error" onClick={check} title={`${state.message}. Click to try again.`}>
          ⚠ Update failed
        </button>
      )
  }
}
