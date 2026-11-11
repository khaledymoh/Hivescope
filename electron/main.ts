/**
 * Hivescope as a desktop app: starts the same server as `npm start` inside the
 * app, on a free port on 127.0.0.1, and shows the dashboard in its own window.
 *
 * Closing the window keeps Hivescope in the tray, still watching; Quit is in the
 * tray menu. Started with --hidden (as "Start with Windows" does), it opens in the tray.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BrowserWindow, Menu, Notification, type Rectangle, Tray, app, ipcMain, nativeImage, screen, shell } from 'electron'

import { type Hivescope, startHivescope } from '../server/app.ts'
import type { UpdateState } from '../shared/update.ts'
import { Updater } from './updater.ts'

const APP_ID = 'com.hivescope.app'
const IS_MAC = process.platform === 'darwin'
const ROOT_DIR = app.getAppPath()
const ICON = path.join(ROOT_DIR, 'assets', 'icon.png')
// macOS wants a black-and-clear "template" image in the menu bar, which it tints for light and dark.
const TRAY_ICON = path.join(ROOT_DIR, 'assets', IS_MAC ? 'trayTemplate.png' : 'tray.png')

interface Prefs {
  notifications: boolean
  trayHintShown: boolean
  /** The window's last size and place (its normal, not maximized, bounds). */
  bounds?: Rectangle
  maximized?: boolean
}
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json')
const prefs: Prefs = { notifications: true, trayHintShown: false }
try {
  Object.assign(prefs, JSON.parse(readFileSync(PREFS_FILE, 'utf8')))
} catch {
  // First run: defaults.
}
const savePrefs = () => {
  try {
    writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2))
  } catch {
    // Not fatal: the choice just won't be remembered.
  }
}

let win: BrowserWindow | undefined
let tray: Tray | undefined
let hive: Hivescope | undefined
let quitting = false

const updater = new Updater({
  onChange: state => {
    win?.webContents.send('update:changed', state)
    buildTrayMenu()
    notifyReady(state)
  },
  beforeQuit: () => (quitting = true),
})

/** Turns every Hivescope notification on or off, from the tray or the page; both show the change. */
function setNotifications(on: boolean) {
  prefs.notifications = on
  savePrefs()
  buildTrayMenu()
  win?.webContents.send('prefs:changed', { notifications: on })
}
let notifiedVersion: string | undefined
/** One notification per version when it's downloaded and ready. */
function notifyReady(state: UpdateState) {
  if (state.status !== 'ready' || notifiedVersion === state.next || !prefs.notifications || !Notification.isSupported()) return
  notifiedVersion = state.next
  const note = new Notification({ title: `Hivescope ${state.next} is ready`, body: 'Restart Hivescope to update. Click to open it.', icon: ICON })
  note.on('click', () => show())
  note.show()
}

const LOADING = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Hivescope</title><style>
html,body{height:100%;margin:0;background:#0e0e11;color:#8b8a93;font:15px 'Segoe UI',system-ui,sans-serif}
body{display:grid;place-items:center}div{text-align:center}
svg{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.45;transform:scale(.92)}}
b{display:block;color:#e8e6e3;font-size:20px;margin:14px 0 6px}
</style></head><body><div><svg viewBox="0 0 32 32" width="64" height="64"><path d="M16 2l12 7v14l-12 7-12-7V9z" fill="#f5a524"/><circle cx="16" cy="16" r="5" fill="#0e0e11"/></svg>
<b>Hivescope</b>Reading your Claude Code transcripts…</div></body></html>`)}`

function show(sessionId?: string) {
  if (!win) createWindow()
  if (!win) return
  if (sessionId && hive) void win.loadURL(`${hive.url}/#${sessionId}`)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const MIN_WIDTH = 900
const MIN_HEIGHT = 600

/** True when enough of the rectangle is on a connected screen to grab and move it. */
function onScreen(b: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y)
    return w >= 200 && h >= 100
  })
}

/** The saved place if it's still on a screen; otherwise 70% of the main screen, centered. */
function startBounds(): Rectangle {
  const saved = prefs.bounds
  if (saved && saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT && onScreen(saved)) return saved
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.max(Math.min(area.width, MIN_WIDTH), Math.round(area.width * 0.7))
  const height = Math.max(Math.min(area.height, MIN_HEIGHT), Math.round(area.height * 0.7))
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  // Normal bounds are the size it returns to when un-maximized, so both are kept.
  prefs.bounds = win.getNormalBounds()
  prefs.maximized = win.isMaximized()
  savePrefs()
}

function createWindow() {
  const hidden = process.argv.includes('--hidden')
  win = new BrowserWindow({
    ...startBounds(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Hivescope',
    icon: ICON,
    backgroundColor: '#0e0e11',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  })
  win.removeMenu()
  if (prefs.maximized) win.maximize()
  if (!hidden) win.show()

  // Remember the size and place as they change, a moment after the last move.
  let saveTimer: NodeJS.Timeout | undefined
  const saveSoon = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveBounds, 500)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(event as 'resize', saveSoon)
  void win.loadURL(hive ? hive.url : LOADING)

  // The window only ever shows Hivescope; any other link opens in the browser.
  const isOwn = (url: string) => !!hive && url.startsWith(hive.url)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isOwn(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwn(url)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  win.on('close', event => {
    saveBounds()
    if (quitting) return
    event.preventDefault()
    win?.hide()
    if (!prefs.trayHintShown && Notification.isSupported()) {
      new Notification({ title: 'Hivescope is still watching', body: 'It keeps running in the tray. Right-click the honey hexagon to quit.', icon: ICON }).show()
      prefs.trayHintShown = true
      savePrefs()
    }
  })
  win.on('closed', () => (win = undefined))
}

// Windows matches the login item by its arguments, so reading it needs the same ones.
const LOGIN_ARGS = ['--hidden']

function buildTrayMenu() {
  if (!tray) return
  const startsWithWindows = app.isPackaged && app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin
  const loginLabel = IS_MAC ? 'Open at login' : 'Start with Windows'
  const u = updater.state
  const updateItem: Electron.MenuItemConstructorOptions =
    u.status === 'ready'
      ? { label: `Restart to update to ${u.next}`, click: () => updater.install() }
      : u.status === 'downloading'
        ? { label: `Downloading Hivescope ${u.next}…`, enabled: false }
        : { label: u.status === 'checking' ? 'Checking for updates…' : 'Check for updates', enabled: u.status !== 'checking', click: () => void updater.check(true) }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Hivescope', click: () => show() },
      { type: 'separator' },
      ...(updater.enabled ? [updateItem, { type: 'separator' as const }] : []),
      {
        label: 'Notifications',
        sublabel: 'Subagents finishing, sessions waiting for you, updates',
        type: 'checkbox',
        checked: prefs.notifications,
        click: item => setNotifications(item.checked),
      },
      {
        // Only the installed app: from `npm run desktop` it would register the bare Electron runtime.
        label: app.isPackaged ? loginLabel : `${loginLabel} (installed app only)`,
        type: 'checkbox',
        enabled: app.isPackaged,
        checked: startsWithWindows,
        click: item => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS })
          buildTrayMenu()
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Hivescope',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON)
  if (IS_MAC) image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('Hivescope')
  tray.on('click', () => show())
  buildTrayMenu()
}

/** Tray tooltip, and "subagent finished" and "waiting for you" notifications, after every change. */
function watchActivity(h: Hivescope) {
  const known = new Map<string, 'running' | 'done'>()
  /** Session id -> what it waited on last time, to notify once per new question. */
  const waits = new Map<string, string>()
  let seeded = false
  const check = () => {
    const now = Date.now()
    let live = 0
    let running = 0
    const finished: { type: string; description: string; title: string; sessionId: string }[] = []
    const asks: { title: string; text: string; sessionId: string }[] = []
    let waiting = 0
    for (const session of h.store.sessions.values()) {
      // With the running process's state: only open sessions wait on you.
      const summary = h.store.summaryOf(session, now)
      const w = summary.waiting
      // Questions it can go on without don't interrupt you.
      const key = w && (w.blocked || w.kind !== 'asked') ? `${w.kind}|${w.at}|${w.text}` : ''
      if (key) waiting++
      if (seeded && key && waits.get(session.id) !== key) asks.push({ title: summary.title, text: w!.text, sessionId: session.id })
      waits.set(session.id, key)
      if (summary.status === 'live') live++
      for (const run of session.subagents(now)) {
        if (run.status === 'running') running++
        const before = known.get(run.id)
        if (seeded && before === 'running' && run.status === 'done') {
          finished.push({ type: run.type, description: run.description, title: summary.title, sessionId: session.id })
        }
        known.set(run.id, run.status)
      }
    }
    seeded = true
    tray?.setToolTip(
      `Hivescope · ${waiting ? `${waiting} waiting for you · ` : ''}${live} live session${live === 1 ? '' : 's'} · ${running} subagent${running === 1 ? '' : 's'} running`,
    )

    if (!prefs.notifications || !Notification.isSupported()) return
    for (const a of asks) {
      const note = new Notification({ title: `${a.title} is waiting for you`, body: a.text.slice(0, 240), icon: ICON })
      note.on('click', () => show(a.sessionId))
      note.show()
    }
    // A burst of finishes becomes one notification.
    if (finished.length === 1) {
      const f = finished[0]!
      const note = new Notification({ title: `${f.type} finished`, body: `${f.description || 'Subagent done'}\n${f.title}`, icon: ICON })
      note.on('click', () => show(f.sessionId))
      note.show()
    } else if (finished.length > 1) {
      const note = new Notification({
        title: `${finished.length} subagents finished`,
        body: finished.map(f => `${f.type}: ${f.description}`).join('\n'),
        icon: ICON,
      })
      note.on('click', () => show(finished[0]!.sessionId))
      note.show()
    }
  }
  check()
  h.onChange(check)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  app.on('second-instance', () => show())
  // macOS: clicking the Dock icon brings the window back.
  app.on('activate', () => show())

  // The updater, for the page's toolbar. Only Hivescope's own page may use it.
  const fromOwnPage = (event: Electron.IpcMainInvokeEvent) => !!hive && !!event.senderFrame?.url.startsWith(hive.url)
  ipcMain.handle('update:state', () => updater.state)
  ipcMain.handle('update:check', event => (fromOwnPage(event) ? updater.check(true) : undefined))
  ipcMain.handle('update:install', event => (fromOwnPage(event) ? updater.install() : undefined))
  ipcMain.handle('prefs:get', () => ({ notifications: prefs.notifications }))
  ipcMain.handle('prefs:notifications', (event, on: unknown) => (fromOwnPage(event) && typeof on === 'boolean' ? setNotifications(on) : undefined))
  app.on('before-quit', () => (quitting = true))
  // Stay in the tray when the window is closed.
  app.on('window-all-closed', () => {})

  void app.whenReady().then(async () => {
    createTray()
    createWindow()
    updater.start()
    try {
      const options = {
        days: 7,
        root: path.join(os.homedir(), '.claude', 'projects'),
        dist: path.join(ROOT_DIR, 'dist'),
        // Images Claude opened from your own folders go to the Recycle Bin, never deleted outright.
        trash: (file: string) => shell.trashItem(file),
        log: (message: string) => console.log(message),
      }
      // A fixed port keeps the page's saved choices (grouping, collapsed groups) between
      // launches, since browsers keep them per address; any free port if it's taken.
      try {
        hive = await startHivescope({ ...options, port: 4318 })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
        hive = await startHivescope({ ...options, port: 0 })
      }
      console.log(`Hivescope is running: ${hive.url}`)
      watchActivity(hive)
      if (win) void win.loadURL(hive.url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const page = `<body style="background:#0e0e11;color:#e8e6e3;font:15px system-ui,-apple-system,Segoe UI,sans-serif;padding:40px"><h2>Hivescope could not start</h2><pre style="white-space:pre-wrap;color:#ff5d6c">${message.replace(/</g, '&lt;')}</pre></body>`
      void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
    }
  })

  app.on('will-quit', () => {
    void hive?.close()
  })
}
