/**
 * Gives the dashboard page the few desktop-only things it shows: the updater, for now.
 * Sandboxed, so only contextBridge and ipcRenderer are available here.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { DesktopBridge, DesktopPrefs, UpdateState } from '../shared/update.ts'

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
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get') as Promise<DesktopPrefs>,
    setNotifications: on => ipcRenderer.invoke('prefs:notifications', on) as Promise<void>,
    onChange: callback => {
      const listener = (_: unknown, prefs: DesktopPrefs) => callback(prefs)
      ipcRenderer.on('prefs:changed', listener)
      return () => {
        ipcRenderer.off('prefs:changed', listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('hivescopeDesktop', bridge)
