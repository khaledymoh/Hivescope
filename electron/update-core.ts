/**
 * The parts of the updater that don't need Electron, so tests can run them in Node.
 *
 * Every GitHub release carries one manifest per platform next to its installers:
 *   windows.json  {"version":"0.6.0","files":{"x64":{"file":"Hivescope-Setup-0.6.0.exe","size":…,"sha256":"…"}}}
 *   mac.json      {"version":"0.6.0","files":{"arm64":{…},"x64":{…}}}
 * The app reads the one for its platform from the latest release, at
 * https://github.com/<owner>/<repo>/releases/latest/download/<platform>.json.
 */

export type Platform = 'windows' | 'mac'

export interface ManifestFile {
  file: string
  size: number
  sha256: string
}

export interface Manifest {
  version: string
  files: Partial<Record<string, ManifestFile>>
}

export function platformOf(nodePlatform: string): Platform | undefined {
  if (nodePlatform === 'win32') return 'windows'
  if (nodePlatform === 'darwin') return 'mac'
  return undefined
}

/** Where the latest release's manifest and installers are downloaded from. */
export function releaseUrl(repo: string, file: string): string {
  return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(file)}`
}

/** Checks a manifest's shape; throws a short reason when it's not usable. */
export function parseManifest(json: unknown): Manifest {
  const m = json as Partial<Manifest> | null
  if (!m || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) throw new Error('The release manifest has no version')
  if (!m.files || typeof m.files !== 'object') throw new Error('The release manifest lists no files')
  for (const f of Object.values(m.files)) {
    if (!f || typeof f.file !== 'string' || typeof f.sha256 !== 'string' || typeof f.size !== 'number' || /[\\/]/.test(f.file)) {
      throw new Error('The release manifest has a broken file entry')
    }
  }
  return m as Manifest
}

/** The installer for this machine's architecture, if the release has one. */
export function pickFile(manifest: Manifest, arch: string): ManifestFile | undefined {
  return manifest.files[arch]
}

/**
 * Compares semver-like versions: 1 if a is newer, -1 if older, 0 if equal.
 * A prerelease (0.6.0-beta.1) is older than its release (0.6.0).
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('+')[0]!.split(/-(.*)/s)
    return { nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  const xp = x.pre.split('.')
  const yp = y.pre.split('.')
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i]
    const q = yp[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p) ? Number(p) : undefined
    const qn = /^\d+$/.test(q) ? Number(q) : undefined
    if (pn !== undefined && qn !== undefined && pn !== qn) return Math.sign(pn - qn)
    if (pn === undefined || qn === undefined) {
      if (p !== q) return p < q ? -1 : 1
    }
  }
  return 0
}

/**
 * How the Windows installer (electron-builder's NSIS) is run for an update, as electron-updater runs it:
 * --updated reinstalls into the folder it was installed in (from the registry) and keeps shortcuts as
 * they are, /S skips the wizard, and --force-run opens the new version when it's done. The installer
 * itself waits for, or closes, the running Hivescope before it replaces its files.
 */
export const WINDOWS_UPDATE_ARGS = ['--updated', '/S', '--force-run']

/**
 * A macOS script that waits for this Hivescope to exit, copies the .app out of the new disk image
 * over the installed one and opens it. If anything fails, it opens the disk image in Finder instead,
 * so the update can be dragged in by hand. Files the app downloads itself carry no quarantine mark,
 * so Gatekeeper doesn't stop the new version.
 */
export function macUpdateScript(pid: number, dmg: string, app: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh
while kill -0 ${pid} 2>/dev/null; do sleep 1; done
dmg=${q(dmg)}
app=${q(app)}
mnt=$(mktemp -d /tmp/hivescope-update.XXXXXX)
ok=
if hdiutil attach -nobrowse -noautoopen -quiet -mountpoint "$mnt" "$dmg"; then
  src=$(ls -d "$mnt"/*.app | head -1)
  rm -rf "$app.new"
  if [ -n "$src" ] && ditto "$src" "$app.new" && rm -rf "$app" && mv "$app.new" "$app"; then ok=1; fi
  hdiutil detach "$mnt" -quiet
fi
rmdir "$mnt" 2>/dev/null
if [ -n "$ok" ]; then
  xattr -dr com.apple.quarantine "$app" 2>/dev/null
  rm -f "$dmg"
  open "$app"
else
  rm -rf "$app.new"
  open "$dmg"
fi
`
}

/** The .app bundle around a macOS executable (…/Hivescope.app/Contents/MacOS/Hivescope), if it is one. */
export function appBundleOf(execPath: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m?.[1]
}
