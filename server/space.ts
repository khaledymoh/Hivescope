/**
 * Freeing the disk space agents leave behind, and only that:
 *
 *  - tasks:       <temp>/claude/<project>/<session>/tasks/**        background command output
 *  - scratchpad:  <temp>/claude/<project>/<session>/scratchpad/**   an agent's temporary files
 *  - screenshots: ~/.claude/projects/<project>/<session>/tool-results/*.{png,jpg,…}
 *
 * Transcripts, images you pasted, edit history and anything else are never touched.
 *
 * The page never sends a path: it names kinds and, optionally, one session, and the
 * server lists the files again. Every file must sit in one of the folders above under a
 * session folder named like a session id, reached without links or junctions, and its
 * real path must stay inside the root. A file is kept when its session is live or was
 * active lately, or when the file itself was written lately: an open session can still
 * have a dev server writing into tasks/.
 */
import type { Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { type FileStat, LEFTOVER_KINDS, type LeftoverKind, type SpaceReport, type SpaceSession } from '../shared/types.ts'
import type { ShotRoots } from './shots.ts'

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE = /\.(png|jpe?g|webp|gif)$/i
export const QUIET_HOURS = 2
const QUIET_MS = QUIET_HOURS * 3_600_000

interface Spot {
  kind: LeftoverKind
  root: keyof ShotRoots
  folder: string
  /** How many folder levels below it to look into. */
  depth: number
  imagesOnly: boolean
}
const SPOTS: Spot[] = [
  { kind: 'tasks', root: 'temp', folder: 'tasks', depth: 4, imagesOnly: false },
  { kind: 'scratchpad', root: 'temp', folder: 'scratchpad', depth: 8, imagesOnly: false },
  { kind: 'screenshots', root: 'projects', folder: 'tool-results', depth: 0, imagesOnly: true },
]

/** What Hivescope knows about a session from its transcript. */
export interface SessionInfo {
  title: string
  projectName: string
  live: boolean
  lastAt: number
}

interface Leftover {
  kind: LeftoverKind
  sessionId: string
  file: string
  /** The kind's folder in that session, for tidying empty folders afterwards. */
  top: string
  bytes: number
  at: number
}

async function dirents(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Plain files below dir, never following a link or junction (they show up as links, not folders). */
async function walk(dir: string, depth: number, imagesOnly: boolean, out: string[]) {
  for (const e of await dirents(dir)) {
    if (e.isSymbolicLink()) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0) await walk(p, depth - 1, imagesOnly, out)
    } else if (e.isFile() && (!imagesOnly || IMAGE.test(e.name))) out.push(p)
  }
}

async function realBase(dir: string): Promise<string | undefined> {
  try {
    return await fs.realpath(dir)
  } catch {
    return undefined
  }
}

/** Every leftover file on disk, of the kinds asked for, read fresh. */
export async function collect(roots: ShotRoots, kinds: LeftoverKind[] = LEFTOVER_KINDS, onlySession?: string): Promise<Leftover[]> {
  const out: Leftover[] = []
  for (const spot of SPOTS.filter(s => kinds.includes(s.kind))) {
    const base = await realBase(roots[spot.root])
    if (!base) continue
    for (const project of await dirents(base)) {
      if (!project.isDirectory()) continue
      for (const session of await dirents(path.join(base, project.name))) {
        if (!session.isDirectory() || !SESSION_ID.test(session.name)) continue
        if (onlySession && session.name !== onlySession) continue
        const top = path.join(base, project.name, session.name, spot.folder)
        try {
          const st = await fs.lstat(top)
          if (!st.isDirectory() || st.isSymbolicLink()) continue
        } catch {
          continue
        }
        const files: string[] = []
        await walk(top, spot.depth, spot.imagesOnly, files)
        for (const file of files) {
          try {
            const real = await fs.realpath(file)
            if (!real.startsWith(top + path.sep)) continue
            const st = await fs.lstat(file)
            if (!st.isFile()) continue
            out.push({ kind: spot.kind, sessionId: session.name, file, top, bytes: st.size, at: st.mtimeMs })
          } catch {
            // Gone, or unreadable: leave it.
          }
        }
      }
    }
  }
  return out
}

/** Whether a file stays for now. */
function held(f: Leftover, info: Map<string, SessionInfo>, now: number): boolean {
  const s = info.get(f.sessionId)
  if (s && (s.live || now - s.lastAt < QUIET_MS)) return true
  return now - f.at < QUIET_MS
}

const empty = (): FileStat => ({ files: 0, bytes: 0 })
const add = (to: FileStat, bytes: number) => {
  to.files++
  to.bytes += bytes
}

export async function spaceReport(roots: ShotRoots, info: Map<string, SessionInfo>, now = Date.now()): Promise<SpaceReport> {
  const files = await collect(roots)
  const totals = Object.fromEntries(LEFTOVER_KINDS.map(k => [k, { free: empty(), held: empty() }])) as SpaceReport['totals']
  const by = new Map<string, SpaceSession>()
  for (const f of files) {
    let s = by.get(f.sessionId)
    if (!s) {
      const known = info.get(f.sessionId)
      s = {
        sessionId: f.sessionId,
        title: known?.title,
        projectName: known?.projectName,
        live: known?.live ?? false,
        lastAt: 0,
        free: { tasks: empty(), scratchpad: empty(), screenshots: empty() },
        held: empty(),
      }
      by.set(f.sessionId, s)
    }
    s.lastAt = Math.max(s.lastAt, f.at)
    if (held(f, info, now)) {
      add(s.held, f.bytes)
      add(totals[f.kind].held, f.bytes)
    } else {
      add(s.free[f.kind], f.bytes)
      add(totals[f.kind].free, f.bytes)
    }
  }
  const freeBytes = (s: SpaceSession) => LEFTOVER_KINDS.reduce((n, k) => n + s.free[k].bytes, 0)
  const sessions = [...by.values()].sort((a, b) => freeBytes(b) - freeBytes(a) || b.held.bytes - a.held.bytes)
  return { scannedAt: now, quietHours: QUIET_HOURS, totals, sessions }
}

/** Removes the empty folders an agent left under top, keeping top itself. */
async function prune(dir: string, top: boolean) {
  for (const e of await dirents(dir)) {
    if (e.isDirectory() && !e.isSymbolicLink()) await prune(path.join(dir, e.name), false)
  }
  if (!top) await fs.rmdir(dir).catch(() => {})
}

export interface FreeResult {
  deleted: number
  bytes: number
  /** In use or already gone. */
  skipped: number
  /** Kept because the session or file is active. */
  held: number
}

export async function freeSpace(
  roots: ShotRoots,
  info: Map<string, SessionInfo>,
  ask: { kinds: LeftoverKind[]; sessionId?: string },
  now = Date.now(),
): Promise<FreeResult> {
  const kinds = ask.kinds.filter(k => LEFTOVER_KINDS.includes(k))
  if (kinds.length === 0 || (ask.sessionId !== undefined && !SESSION_ID.test(ask.sessionId))) return { deleted: 0, bytes: 0, skipped: 0, held: 0 }
  const result: FreeResult = { deleted: 0, bytes: 0, skipped: 0, held: 0 }
  const tops = new Set<string>()
  for (const f of await collect(roots, kinds, ask.sessionId)) {
    if (held(f, info, now)) {
      result.held++
      continue
    }
    try {
      await fs.unlink(f.file)
      result.deleted++
      result.bytes += f.bytes
      tops.add(f.top)
    } catch {
      // Open in another program (EBUSY/EPERM on Windows) or already gone.
      result.skipped++
    }
  }
  for (const top of tops) await prune(top, true)
  return result
}
