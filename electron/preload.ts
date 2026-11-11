/**
 * Gives the dashboard page the few desktop-only things it shows: the updater, for now.
 * Sandboxed, so only contextBridge and ipcRenderer are available here.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { DesktopBridge, UpdateState } from '../shared/update.ts'

const bridge: DesktopBridge = {
  update: {
    state: () => ipcRenderer.invoke('update:state') as Promise<UpdateState>,
    check: () => ipcRenderer.invoke('update:check') as Promise<void>,
    install: () => ipcRenderer.invoke('update:install') as Promise<void>,
    onChange: callback => {
      const listener = (_: unknown, state: UpdateState) => callback(state)
      ipcRenderer.on('update:changed', listener)
      return () => {
        ipcRenderer.off('update:changed', listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('hivescopeDesktop', bridge)
