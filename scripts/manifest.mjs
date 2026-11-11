// Writes the update manifest for one platform next to its installers:
//   node scripts/manifest.mjs windows   -> release/<version>/windows.json
//   node scripts/manifest.mjs mac       -> release/<version>/mac.json
// Installed copies of Hivescope read it from the latest GitHub release to find,
// download and verify their update (see electron/update-core.ts).
//
// Installers are found by pattern rather than exact name, and each one's architecture
// is read from its name: "arm64" for Apple silicon, anything else is x64.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const platform = process.argv[2]
if (platform !== 'windows' && platform !== 'mac') {
  console.error('Usage: node scripts/manifest.mjs windows|mac')
  process.exit(1)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const dir = path.join('release', version)
const listing = existsSync(dir) ? readdirSync(dir) : []
const ext = platform === 'windows' ? '.exe' : '.dmg'
// Uninstallers and other helper .exe files electron-builder leaves next to the installer don't count.
const installers = listing.filter(name => name.endsWith(ext) && name.includes(version) && !/uninstall/i.test(name))

const wanted = platform === 'windows' ? ['x64'] : ['arm64', 'x64']
const files = {}
for (const name of installers) {
  const arch = /arm64/i.test(name) ? 'arm64' : 'x64'
  if (files[arch]) {
    console.error(`Two ${arch} installers in ${dir}: ${files[arch].file} and ${name}`)
    process.exit(1)
  }
  const full = path.join(dir, name)
  files[arch] = { file: name, size: statSync(full).size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') }
}

const missing = wanted.filter(arch => !files[arch])
if (missing.length) {
  console.error(`No ${missing.join(' or ')} ${ext} for ${version} in ${dir}. It holds:\n  ${listing.join('\n  ') || '(nothing)'}`)
  process.exit(1)
}
// GitHub renames uploaded files that contain spaces, which would break the download link.
for (const f of Object.values(files)) {
  if (/\s/.test(f.file)) {
    console.error(`"${f.file}" has a space in its name; GitHub would rename it. Fix artifactName in package.json.`)
    process.exit(1)
  }
}

const out = path.join(dir, `${platform}.json`)
writeFileSync(out, `${JSON.stringify({ version, files }, null, 2)}\n`)
console.log(`Wrote ${out}:`)
for (const [arch, f] of Object.entries(files)) console.log(`  ${arch}  ${f.file}  ${f.size} bytes`)
