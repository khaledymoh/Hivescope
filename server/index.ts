/**
 * Hivescope from the command line: serves the dashboard in your browser.
 *
 *   npm start                     build the page and serve it on http://127.0.0.1:4317
 *   npm run serve -- --days 14    serve only, with a 14-day window
 *
 * The desktop app starts the same server from electron/main.ts.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startHivescope } from './app.ts'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return (i > 0 && process.argv[i + 1]) || process.env[`HIVESCOPE_${name.toUpperCase()}`] || fallback
}

const port = Number(arg('port', '4317'))

startHivescope({
  port,
  days: Number(arg('days', '7')),
  root: arg('root', path.join(os.homedir(), '.claude', 'projects')),
  dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
  tempRoot: arg('temp-root', path.join(os.tmpdir(), 'claude')),
  log: message => console.log(message),
})
  .then(app => console.log(`Hivescope is running: ${app.url}`))
  .catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Hivescope: port ${port} is taken, probably by another Hivescope already running. Close it, or start with --port 4318.`)
    } else {
      console.error(err)
    }
    process.exit(1)
  })
