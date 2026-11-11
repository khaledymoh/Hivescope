// Draws the Hivescope icon (a honey hexagon with a dark core) and writes
// build/icon.png (512 px), build/icon.ico (16-256 px) and build/tray.png (32 px).
// Plain Node: a tiny PNG encoder on top of zlib, no image libraries.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')
const HONEY = [245, 165, 36]
const CORE = [14, 14, 17]
const RIM = [255, 196, 92]

// The hexagon from the page icon, on a 32-unit grid.
const HEX = [
  [16, 2],
  [28, 9],
  [28, 23],
  [16, 30],
  [4, 23],
  [4, 9],
]

function inside(x, y, poly) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/**
 * RGBA pixels, 4x4 supersampled for smooth edges. A template image (the macOS menu bar's) is
 * black where the hexagon is and clear in its core; macOS tints it for light and dark menu bars.
 */
function draw(size, template = false) {
  const px = Buffer.alloc(size * size * 4)
  const ss = 4
  const scale = size / 32
  // Small sizes get a thicker core so it still reads at 16 px.
  const coreR = size <= 32 ? 5.5 : 5
  const innerHex = HEX.map(([x, y]) => [16 + (x - 16) * 0.86, 16 + (y - 16) * 0.86])
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) / scale
          const uy = (y + (sy + 0.5) / ss) / scale
          if (!inside(ux, uy, HEX)) continue
          const d = Math.hypot(ux - 16, uy - 16)
          if (template && d < coreR) continue
          const c = template ? [0, 0, 0] : d < coreR ? CORE : inside(ux, uy, innerHex) ? HONEY : RIM
          r += c[0]
          g += c[1]
          b += c[2]
          a += 255
        }
      }
      const n = ss * ss
      const covered = a / 255
      const i = (y * size + x) * 4
      if (covered) {
        px[i] = Math.round(r / covered)
        px[i + 1] = Math.round(g / covered)
        px[i + 2] = Math.round(b / covered)
      }
      px[i + 3] = Math.round(a / n)
    }
  }
  return px
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, template = false) {
  const px = draw(size, template)
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** An .ico holding PNG images, which Windows Vista and later read. */
function ico(sizes) {
  // Not sizes.map(png): map's index argument would turn on png's `template` flag.
  const images = sizes.map(size => png(size))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = 6 + 16 * sizes.length
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(images[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += images[i].length
    return e
  })
  return Buffer.concat([header, ...entries, ...images])
}

// build/ is for the installer; assets/ ships inside the app (window and tray icons).
const ASSETS = path.join(OUT, '..', 'assets')
mkdirSync(OUT, { recursive: true })
mkdirSync(ASSETS, { recursive: true })
writeFileSync(path.join(OUT, 'icon.png'), png(512))
writeFileSync(path.join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
writeFileSync(path.join(ASSETS, 'icon.png'), png(256))
writeFileSync(path.join(ASSETS, 'tray.png'), png(32))
// macOS menu bar: 16 pt, plus @2x for Retina screens (Electron picks it up by name).
writeFileSync(path.join(ASSETS, 'trayTemplate.png'), png(16, true))
writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), png(32, true))
console.log(`Icons written to ${OUT} and ${ASSETS}`)
