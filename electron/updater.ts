/**
 * Updates the installed app from the repo's latest GitHub release (see update-core.ts for the layout).
 *
 * Checks a little after start and every few hours, and only says when there's a newer version: the
 * toolbar offers "Install <version>". Clicking it downloads the installer, checks it against the
 * manifest's sha256, quits Hivescope and installs the new version without any wizard, then opens it
 * again: on Windows the installer does it in silent mode; on macOS a small script swaps the .app.
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
  /** A newer release found by the last check, not downloaded yet. */
  private available?: { version: string; entry: ManifestFile }
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

  /** What the toolbar shows when nothing is going on: a known update, a downloaded one, or nothing. */
  private resting(version: string, checkedAt?: number): UpdateState {
    if (this.downloaded) return { status: 'ready', version, next: this.downloaded.version }
    if (this.available) return { status: 'available', version, next: this.available.version, size: this.available.entry.size }
    return { status: 'idle', version, checkedAt }
  }

  /**
   * Looks for a newer release. It only says so: nothing downloads until Install is clicked.
   * `manual` checks show their errors; background ones stay quiet.
   */
  async check(manual: boolean): Promise<void> {
    const s = this.state
    if (!this.enabled || s.status === 'checking' || s.status === 'downloading' || s.status === 'installing') return
    if ((s.status === 'ready' || s.status === 'available') && !manual) return
    const version = app.getVersion()
    this.cleanOld()
    this.set({ status: 'checking', version })
    try {
      const res = await net.fetch(this.url(`${this.platform}.json`), { cache: 'no-store' })
      if (res.status === 404) throw new Error('No release has been published yet')
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const manifest = parseManifest(await res.json())
      if (compareVersions(manifest.version, version) <= 0) {
        this.available = undefined
        this.set(this.resting(version, Date.now()))
        return
      }
      const file = pickFile(manifest, process.arch)
      if (!file) throw new Error(`Hivescope ${manifest.version} has no installer for ${process.arch}`)
      // A newer release than one downloaded earlier replaces it.
      if (this.downloaded && this.downloaded.version !== manifest.version) this.downloaded = undefined
      this.available = { version: manifest.version, entry: file }
      this.set(this.resting(version))
    } catch (err) {
      const message = friendly(err)
      console.warn(`Update check failed: ${message}`)
      this.set(manual ? { status: 'error', version, message } : this.resting(version))
    }
  }

  /** Downloads the available update if it isn't yet, checks it, then quits and installs it. */
  async install(): Promise<void> {
    const version = app.getVersion()
    try {
      if (this.state.status === 'available' && this.available) await this.download(this.available.version, this.available.entry)
      if (this.state.status !== 'ready' || !this.downloaded) return
      if (process.platform === 'win32') this.installWindows(this.downloaded.file)
      else this.installMac(this.downloaded.file)
    } catch (err) {
      const message = friendly(err)
      console.warn(`Update failed: ${message}`)
      this.set({ status: 'error', version, message })
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

/** A short reason something failed; network errors say GitHub couldn't be reached. */
function friendly(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.startsWith('net::') ? `Can't reach GitHub (${raw.slice(5)})` : raw
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
