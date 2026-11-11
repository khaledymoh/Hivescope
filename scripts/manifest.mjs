// Writes the update manifest for one platform next to its installers:
//   node scripts/manifest.mjs windows   -> release/<version>/windows.json
//   node scripts/manifest.mjs mac       -> release/<version>/mac.json
// Installed copies of Hivescope read it from the latest GitHub release to find,
// download and verify their update (see electron/update-core.ts).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const platform = process.argv[2]
if (platform !== 'windows' && platform !== 'mac') {
  console.error('Usage: node scripts/manifest.mjs windows|mac')
  process.exit(1)
}

const { productName, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const dir = path.join('release', version)
const wanted =
  platform === 'windows'
    ? { x64: `${productName}-Setup-${version}.exe` }
    : { arm64: `${productName}-${version}-arm64.dmg`, x64: `${productName}-${version}-x64.dmg` }

const files = {}
for (const [arch, file] of Object.entries(wanted)) {
  const full = path.join(dir, file)
  if (!existsSync(full)) {
    console.error(`Missing ${full}: build the installers first (npm run dist:${platform === 'windows' ? 'win' : 'mac'})`)
    process.exit(1)
  }
  files[arch] = { file, size: statSync(full).size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') }
}

const out = path.join(dir, `${platform}.json`)
writeFileSync(out, `${JSON.stringify({ version, files }, null, 2)}\n`)
console.log(`Wrote ${out}`)
