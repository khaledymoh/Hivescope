// Bundles the desktop app's main process (electron/main.ts and the server it
// starts) and the window's preload into CommonJS files Electron can load.
//
// The GitHub repo the app updates from is baked in here: GitHub Actions sets
// GITHUB_REPOSITORY ("owner/repo"). Set HIVESCOPE_UPDATE_REPO to build one
// yourself that updates from a repo. Without either, updates are off.
import { build } from 'esbuild'

const repo = process.env.HIVESCOPE_UPDATE_REPO ?? process.env.GITHUB_REPOSITORY ?? ''

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
  define: { 'process.env.HIVESCOPE_UPDATE_REPO': JSON.stringify(repo) },
}

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }),
])
console.log(`Built dist-electron/main.cjs and preload.cjs${repo ? ` (updates from ${repo})` : ' (no update repo)'}`)
