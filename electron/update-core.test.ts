import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WINDOWS_UPDATE_ARGS, appBundleOf, compareVersions, macUpdateScript, parseManifest, pickFile, platformOf, releaseUrl } from './update-core.ts'

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('0.6.0', '0.5.0'), 1)
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0)
  assert.equal(compareVersions('v0.5.0', '0.5.0'), 0)
  assert.equal(compareVersions('0.5.10', '0.5.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.6.0-beta.1', '0.6.0'), -1)
  assert.equal(compareVersions('0.6.0', '0.6.0-beta.1'), 1)
  assert.equal(compareVersions('0.6.0-beta.2', '0.6.0-beta.10'), -1)
  assert.equal(compareVersions('0.6.0-beta', '0.6.0-beta.1'), -1)
  assert.equal(compareVersions('0.6.0-beta.1', '0.5.9'), 1)
})

test('parseManifest accepts a release manifest and rejects broken ones', () => {
  const m = parseManifest({ version: '0.6.0', files: { x64: { file: 'Hivescope-Setup-0.6.0.exe', size: 10, sha256: 'ab' } } })
  assert.equal(pickFile(m, 'x64')?.file, 'Hivescope-Setup-0.6.0.exe')
  assert.equal(pickFile(m, 'arm64'), undefined)
  assert.throws(() => parseManifest({ files: {} }), /no version/)
  assert.throws(() => parseManifest({ version: '0.6.0' }), /no files/)
  assert.throws(() => parseManifest({ version: '0.6.0', files: { x64: { file: 'a.exe' } } }), /broken/)
  // A file name can't climb out of the download folder.
  assert.throws(() => parseManifest({ version: '0.6.0', files: { x64: { file: '../evil.exe', size: 1, sha256: 'ab' } } }), /broken/)
})

test('platform, release URL and app bundle', () => {
  assert.equal(platformOf('win32'), 'windows')
  assert.equal(platformOf('darwin'), 'mac')
  assert.equal(platformOf('linux'), undefined)
  assert.equal(releaseUrl('me/hivescope', 'mac.json'), 'https://github.com/me/hivescope/releases/latest/download/mac.json')
  assert.equal(appBundleOf('/Applications/Hivescope.app/Contents/MacOS/Hivescope'), '/Applications/Hivescope.app')
  assert.equal(appBundleOf('C:\\Programs\\Hivescope\\Hivescope.exe'), undefined)
})

test('the Windows installer runs silently, as an update, and reopens the app', () => {
  assert.deepEqual([...WINDOWS_UPDATE_ARGS].sort(), ['--force-run', '--updated', '/S'])
})

test('the macOS script replaces the .app from the disk image, or opens the image', () => {
  const s = macUpdateScript(77, "/Users/o'neil/updates/Hivescope-0.6.0-arm64.dmg", '/Applications/Hivescope.app')
  assert.match(s, /kill -0 77/)
  assert.match(s, /dmg='\/Users\/o'\\''neil\/updates\/Hivescope-0\.6\.0-arm64\.dmg'/)
  assert.match(s, /hdiutil attach -nobrowse/)
  assert.match(s, /ditto "\$src" "\$app\.new"/)
  assert.match(s, /open "\$dmg"/)
})
