/**
 * Screenshots that agents left on disk, per session, and deleting them.
 *
 *  - tool:       ~/.claude/projects/<project>/<session>/tool-results/*.{png,jpg,…}
 *                (browser, screen-control and other tools' screenshots)
 *  - scratchpad: <temp>/claude/<project>/<session>/scratchpad/**   (images agents saved)
 *  - pasted:     <temp>/claude/<project>/<session>/images/**       (images you pasted in)
 *
 * Files are named to the page by an opaque id (root + relative path, base64url),
 * and every id is checked again before a file is served or deleted: it must
 * resolve inside one of these folders, be an image, and be of an allowed kind.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ShotFile, ShotKind, ShotSession } from '../shared/types.ts'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i

export interface ShotRoots {
  /** ~/.claude/projects */
  projects: string
  /** <temp>/claude */
  temp: string
}

type Root = keyof ShotRoots

/** Whether a session opened this exact image file; only those are served as `opened`. */
export type OpenedCheck = (sessionId: string, file: string) => boolean

const encode = (root: Root, rel: string) => Buffer.from(`${root}:${rel.split(path.sep).join('/')}`).toString('base64url')

/** The file an id names, or undefined when it isn't a screenshot Hivescope may touch. */
export function resolveShot(roots: ShotRoots, id: string, opened?: OpenedCheck): { file: string; kind: ShotKind; sessionId: string } | undefined {
  let decoded: string
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
  const colon = decoded.indexOf(':')
  const root = decoded.slice(0, colon) as Root | 'opened'
  const rel = decoded.slice(colon + 1)
  // An image a session opened elsewhere: served only when that session's transcript shows it opening that exact file.
  // Without the check (as when deleting) it never resolves, so these are never deleted.
  if (root === 'opened') {
    const bar = rel.indexOf('|')
    const sessionId = rel.slice(0, bar)
    const file = rel.slice(bar + 1)
    if (bar < 1 || !opened || !IMAGE.test(file) || !path.isAbsolute(file) || !opened(sessionId, file)) return undefined
    return { file, kind: 'opened', sessionId }
  }
  if (!(root === 'projects' || root === 'temp') || !rel || !IMAGE.test(rel)) return undefined
  const base = path.resolve(roots[root])
  const file = path.resolve(base, ...rel.split('/'))
  if (!file.startsWith(base + path.sep)) return undefined
  const parts = path.relative(base, file).split(path.sep)
  // <project>/<session>/<folder>/...
  const [, sessionId, folder] = parts
  if (!sessionId || parts.length < 4) return undefined
  if (root === 'projects' && folder === 'tool-results' && parts.length === 4) return { file, kind: 'tool', sessionId }
  if (root === 'temp' && folder === 'scratchpad') return { file, kind: 'scratchpad', sessionId }
  if (root === 'temp' && folder === 'images') return { file, kind: 'pasted', sessionId }
  return undefined
}

async function walk(dir: string, depth: number, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out)
    else if (e.isFile() && IMAGE.test(e.name)) out.push(p)
  }
}

/** Every screenshot on disk, read fresh each time (a few thousand files at most). */
export async function listShots(roots: ShotRoots): Promise<ShotFile[]> {
  const found: { root: Root; file: string }[] = []
  for (const root of ['projects', 'temp'] as Root[]) {
    const base = roots[root]
    let projects: string[] = []
    try {
      projects = await fs.readdir(base)
    } catch {
      continue
    }
    for (const project of projects) {
      let sessions: import('node:fs').Dirent[] = []
      try {
        sessions = await fs.readdir(path.join(base, project), { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        const dirs = root === 'projects' ? [['tool-results', 0]] : [['scratchpad', 6], ['images', 2]]
        for (const [folder, depth] of dirs as [string, number][]) {
          const files: string[] = []
          await walk(path.join(base, project, s.name, folder), depth, files)
          for (const file of files) found.push({ root, file })
        }
      }
    }
  }
  const out: ShotFile[] = []
  for (const { root, file } of found) {
    const id = encode(root, path.relative(roots[root], file))
    const hit = resolveShot(roots, id)
    if (!hit) continue
    try {
      const st = await fs.stat(file)
      out.push({ id, name: path.basename(file), kind: hit.kind, sessionId: hit.sessionId, bytes: st.size, at: st.mtimeMs })
    } catch {
      // Gone between listing and stat.
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Images a session opened outside Claude's own folders (those are listed already), that still exist. */
export async function listOpened(roots: ShotRoots, sessionId: string, files: Map<string, number>): Promise<ShotFile[]> {
  const inside = [roots.projects, roots.temp].map(r => path.resolve(r).toLowerCase() + path.sep)
  const out: ShotFile[] = []
  for (const [file, at] of files) {
    if (!IMAGE.test(file) || !path.isAbsolute(file) || inside.some(r => path.resolve(file).toLowerCase().startsWith(r))) continue
    try {
      const st = await fs.stat(file)
      if (!st.isFile()) continue
      out.push({ id: Buffer.from(`opened:${sessionId}|${file}`).toString('base64url'), name: path.basename(file), kind: 'opened', sessionId, bytes: st.size, at, path: file })
    } catch {
      // Deleted or moved since.
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

export function summarize(files: ShotFile[], titles: Map<string, { title: string; projectName: string; live: boolean }>): ShotSession[] {
  const by = new Map<string, ShotSession>()
  for (const f of files) {
    let s = by.get(f.sessionId)
    if (!s) {
      const known = titles.get(f.sessionId)
      s = {
        sessionId: f.sessionId,
        title: known?.title,
        projectName: known?.projectName,
        live: known?.live ?? false,
        count: 0,
        bytes: 0,
        byKind: { tool: { count: 0, bytes: 0 }, scratchpad: { count: 0, bytes: 0 }, pasted: { count: 0, bytes: 0 }, opened: { count: 0, bytes: 0 } },
        lastAt: 0,
      }
      by.set(f.sessionId, s)
    }
    s.count++
    s.bytes += f.bytes
    s.byKind[f.kind].count++
    s.byKind[f.kind].bytes += f.bytes
    s.lastAt = Math.max(s.lastAt, f.at)
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes)
}

/** Deletes files by id after checking each one; skips anything that doesn't resolve. */
export async function deleteShots(
  roots: ShotRoots,
  ids: string[],
  allow: { pasted: boolean },
): Promise<{ deleted: number; bytes: number; skipped: number }> {
  let deleted = 0
  let bytes = 0
  let skipped = 0
  for (const id of new Set(ids)) {
    const hit = resolveShot(roots, id)
    if (!hit || (hit.kind === 'pasted' && !allow.pasted)) {
      skipped++
      continue
    }
    try {
      const st = await fs.stat(hit.file)
      await fs.unlink(hit.file)
      deleted++
      bytes += st.size
    } catch {
      skipped++
    }
  }
  return { deleted, bytes, skipped }
}
