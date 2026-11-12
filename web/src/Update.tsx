import { useEffect, useRef, useState } from 'react'

import type { DesktopBridge, UpdateState } from '../../shared/update'

declare global {
  interface Window {
    /** Set by the desktop app's preload; absent when the page is open in a browser. */
    hivescopeDesktop?: DesktopBridge
  }
}

/** The top bar's notifications switch, in the desktop app only. The tray menu has the same switch. */
export function NotificationsButton() {
  const bridge = window.hivescopeDesktop?.prefs
  const [on, setOn] = useState<boolean>()

  useEffect(() => {
    if (!bridge) return
    void bridge.get().then(p => setOn(p.notifications))
    return bridge.onChange(p => setOn(p.notifications))
  }, [bridge])

  if (!bridge || on === undefined) return null
  return (
    <button
      className={`top-btn icon-btn ${on ? '' : 'muted'}`}
      onClick={() => {
        setOn(!on)
        void bridge.setNotifications(!on)
      }}
      aria-pressed={on}
      aria-label={on ? 'Notifications on' : 'Notifications off'}
      title={on ? 'Notifications on: sessions waiting for you, subagents finishing, alerts and updates. Click to turn them off.' : 'Notifications off. Click to turn them on.'}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        {!on && <path d="M3 3l18 18" />}
      </svg>
    </button>
  )
}

/**
 * The top bar's update button, in the desktop app only. It checks on its own and offers
 * "Install <version>" when there's a newer one: only then does it download, install without a wizard and restart.
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
    case 'available':
      return (
        <button
          className="top-btn update-ready"
          onClick={() => void bridge.install()}
          title={`Hivescope ${state.next} is out (you have ${state.version}). Install downloads it (${Math.round(state.size / 1e6)} MB), then restarts Hivescope on the new version.`}
        >
          ⬆ Install {state.next}
        </button>
      )
    case 'ready':
      return (
        <button className="top-btn update-ready" onClick={() => void bridge.install()} title={`Hivescope ${state.next} is downloaded. Install restarts Hivescope on the new version.`}>
          ⬆ Install {state.next}
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
