/** What the desktop app's updater is doing, as the toolbar shows it. */
export type UpdateState =
  /** No updates in this copy: run from source, or built without a GitHub repo to check. */
  | { status: 'disabled'; version: string; reason: string }
  | { status: 'idle'; version: string; checkedAt?: number }
  | { status: 'checking'; version: string }
  | { status: 'downloading'; version: string; next: string; received: number; total: number }
  /** Downloaded and verified: restarting installs it. */
  | { status: 'ready'; version: string; next: string }
  | { status: 'installing'; version: string; next: string }
  | { status: 'error'; version: string; message: string }

/** What the desktop app's preload puts on `window.hivescopeDesktop`. Absent in a browser. */
export interface DesktopBridge {
  update: {
    state(): Promise<UpdateState>
    check(): Promise<void>
    install(): Promise<void>
    /** Calls back on every change; returns the unsubscribe. */
    onChange(callback: (state: UpdateState) => void): () => void
  }
}
