/**
 * Updates the installed app from the repo's latest GitHub release (see update-core.ts for the layout).
 *
 * Checks a little after start and every few hours. A newer version downloads in the background and
 * is checked against the manifest's sha256; then the toolbar offers "Restart to update". Installing
 * quits Hivescope and installs the new version without any wizard, then opens it again: on Windows the
 * installer does it in silent mode; on macOS a small script that outlives the app swaps the .app.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app, net, shell } from 'electron'

import type { UpdateState } from '../shared/update.ts'
import {
  type ManifestFile,
  WINDOWS_UPDATE_ARGS,
  appBundleOf,
  compareVersions,
  macUpdateScript,
  parseManifest,
  pickFile,
  platformOf,
  releaseUrl,
} from './update-core.ts'

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/** "owner/repo", baked in by scripts/build-electron.mjs from GITHUB_REPOSITORY when GitHub Actions builds the app. */
const BUILT_REPO = process.env.HIVESCOPE_UPDATE_REPO ?? ''

export interface UpdaterOptions {
  /** Called on every state change. */
  onChange: (state: UpdateState) => void
  /** Lets the app quit for real (instead of hiding in the tray) before the installer runs. */
  beforeQuit: () => void
}

export class Updater {
  state: UpdateState
  private readonly dir = path.join(app.getPath('userData'), 'updates')
  private readonly platform = platformOf(process.platform)
  /** A local folder or server to update from instead of GitHub, for testing: HIVESCOPE_UPDATE_URL=http://127.0.0.1:8000/ */
  private readonly base = process.env.HIVESCOPE_UPDATE_URL?.replace(/\/?$/, '/')
  private readonly repo = BUILT_REPO.trim()
  private downloaded?: { version: string; file: string }
  private timer?: NodeJS.Timeout
  private lastEmit = 0

  constructor(private readonly options: UpdaterOptions) {
    const version = app.getVersion()
    if (!app.isPackaged) this.state = { status: 'disabled', version, reason: 'Updates work in the installed app' }
    else if (!this.platform) this.state = { status: 'disabled', version, reason: `No updates for ${process.platform}` }
    else if (!this.base && !/^[\w.-]+\/[\w.-]+$/.test(this.repo)) this.state = { status: 'disabled', version, reason: 'This copy was built without a GitHub repo to update from' }
    else this.state = { status: 'idle', version }
  }

  get enabled(): boolean {
    return this.state.status !== 'disabled'
  }

  start() {
    if (!this.enabled) return
    this.cleanOld()
    // Right after an update, the installer that just ran may still hold its file: try again later.
    setTimeout(() => this.cleanOld(), 2 * 60_000).unref()
    setTimeout(() => void this.check(false), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS)
    this.timer.unref()
  }

  private set(state: UpdateState, throttle = false) {
    this.state = state
    const now = Date.now()
    if (throttle && now - this.lastEmit < 200) return
    this.lastEmit = now
    this.options.onChange(state)
  }

  private url(file: string): string {
    return this.base ? new URL(encodeURIComponent(file), this.base).toString() : releaseUrl(this.repo, file)
  }

  /** Looks for a newer release and downloads it. `manual` checks show their errors; background ones stay quiet. */
  async check(manual: boolean): Promise<void> {
    const s = this.state
    if (!this.enabled || s.status === 'checking' || s.status === 'downloading' || s.status === 'installing') return
    if (s.status === 'ready' && !manual) return
    const version = app.getVersion()
    this.cleanOld()
    this.set({ status: 'checking', version })
    try {
      const res = await net.fetch(this.url(`${this.platform}.json`), { cache: 'no-store' })
      if (res.status === 404) throw new Error('No release has been published yet')
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const manifest = parseManifest(await res.json())
      if (compareVersions(manifest.version, version) <= 0) {
        this.set({ status: 'idle', version, checkedAt: Date.now() })
        return
      }
      const file = pickFile(manifest, process.arch)
      if (!file) throw new Error(`Hivescope ${manifest.version} has no installer for ${process.arch}`)
      await this.download(manifest.version, file)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      console.warn(`Update check failed: ${raw}`)
      const message = raw.startsWith('net::') ? `Can't reach GitHub (${raw.slice(5)})` : raw
      if (manual) this.set({ status: 'error', version, message })
      else this.set(this.downloaded ? { status: 'ready', version, next: this.downloaded.version } : { status: 'idle', version })
    }
  }

  private async download(next: string, entry: ManifestFile) {
    const version = app.getVersion()
    mkdirSync(this.dir, { recursive: true })
    const target = path.join(this.dir, entry.file)
    // Already here from an earlier run.
    if (existsSync(target) && sha256(readFileSync(target)) === entry.sha256) {
      this.downloaded = { version: next, file: target }
      this.set({ status: 'ready', version, next })
      return
    }
    this.set({ status: 'downloading', version, next, received: 0, total: entry.size })
    const res = await net.fetch(this.url(entry.file), { cache: 'no-store' })
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${entry.file} (${res.status})`)
    const partial = `${target}.part`
    const out = createWriteStream(partial)
    const hash = createHash('sha256')
    let received = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.length
        if (!out.write(value)) await new Promise(resolve => out.once('drain', resolve))
        this.set({ status: 'downloading', version, next, received, total: entry.size }, true)
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    } catch (err) {
      out.destroy()
      rmSync(partial, { force: true })
      throw err
    }
    if (hash.digest('hex') !== entry.sha256.toLowerCase()) {
      rmSync(partial, { force: true })
      throw new Error('The downloaded installer is damaged (its checksum does not match)')
    }
    // Renamed only once it's whole, so a half download is never installed.
    rmSync(target, { force: true })
    renameSync(partial, target)
    this.downloaded = { version: next, file: target }
    this.set({ status: 'ready', version, next })
  }

  /** Quits and installs the downloaded version; it opens again when done. */
  install() {
    const d = this.downloaded
    if (!d || this.state.status !== 'ready') return
    const version = app.getVersion()
    try {
      if (process.platform === 'win32') this.installWindows(d.file)
      else this.installMac(d.file)
    } catch (err) {
      this.set({ status: 'error', version, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private installWindows(installer: string) {
    this.quitAndRun(installer, WINDOWS_UPDATE_ARGS)
  }

  private installMac(dmg: string) {
    const bundle = appBundleOf(process.execPath)
    // Running from the disk image, from a quarantined copy macOS moved aside, or from a folder it
    // can't write to: open the disk image so the new version can be dragged in by hand.
    const writable = (() => {
      try {
        if (!bundle || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return false
        accessSync(path.dirname(bundle), constants.W_OK)
        return true
      } catch {
        return false
      }
    })()
    if (!bundle || !writable) {
      void shell.openPath(dmg)
      this.set({ status: 'error', version: app.getVersion(), message: 'Hivescope can’t replace itself here. Drag the new Hivescope from the opened window into Applications.' })
      return
    }
    const script = path.join(this.dir, 'update.sh')
    writeFileSync(script, macUpdateScript(process.pid, dmg, bundle), { mode: 0o755 })
    this.quitAndRun('/bin/sh', [script])
  }

  private quitAndRun(command: string, args: string[]) {
    const log = openSync(path.join(this.dir, 'update-install.log'), 'w')
    const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true })
    child.unref()
    this.set({ status: 'installing', version: app.getVersion(), next: this.downloaded!.version })
    this.options.beforeQuit()
    // A moment for the toolbar to show "Restarting…".
    setTimeout(() => app.quit(), 300)
  }

  /** Removes downloaded installers, except one that's waiting to be installed. Files still in use are left for next time. */
  private cleanOld() {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return // No folder yet.
    }
    for (const name of names) {
      const file = path.join(this.dir, name)
      if (!/\.(exe|dmg|part)$/.test(name) || file === this.downloaded?.file) continue
      if (this.state.status === 'downloading' && name.endsWith('.part')) continue
      try {
        rmSync(file, { force: true })
      } catch {
        // Locked (an installer still closing): the next cleanup gets it.
      }
    }
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
