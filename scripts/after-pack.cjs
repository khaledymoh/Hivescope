// electron-builder hook: on macOS, signs the packed app "ad hoc" (no Apple certificate).
// Packing changes Electron's files, which breaks the signature it ships with, and Apple
// silicon Macs refuse to run an app without a valid one ("Hivescope is damaged").
// Ad hoc signing needs no account; users still see the unidentified-developer
// warning on the first install, but the app runs, and its own updates install silently.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log(`  • signed ad hoc  app=${app}`)
}
