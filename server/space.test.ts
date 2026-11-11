// Uses throwaway folders only: never the real ~/.claude or temp folders.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { type SessionInfo, freeSpace, spaceReport } from './space.ts'

const NOW = Date.now()
const DAY = 86_400_000
const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const LIVE = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'

async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hivescope-space-'))
  const roots = { projects: path.join(base, 'projects'), temp: path.join(base, 'temp') }
  const outside = path.join(base, 'outside')
  const put = async (file: string, bytes = 10, ageMs = 3 * DAY) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Buffer.alloc(bytes))
    const t = new Date(NOW - ageMs)
    await utimes(file, t, t)
  }
  const at = (...p: string[]) => path.join(...p)
  // An old, finished session: everything here goes, except what isn't a leftover.
  await put(at(roots.temp, 'abc123', OLD, 'tasks', 'b1.output'), 1000)
  await put(at(roots.temp, 'abc123', OLD, 'scratchpad', 'run.py'), 200)
  await put(at(roots.temp, 'abc123', OLD, 'scratchpad', 'deep', 'shot.png'), 300)
  await put(at(roots.projects, 'C--work', OLD, 'tool-results', 'mcp-browser-blob-1.jpg'), 100)
  // Kept: a file written a minute ago in that same old session.
  await put(at(roots.temp, 'abc123', OLD, 'tasks', 'fresh.output'), 50, 60_000)
  // Never leftovers: pasted images, saved text output, the transcript, subagent logs.
  await put(at(roots.temp, 'abc123', OLD, 'images', '1.png'), 20)
  await put(at(roots.projects, 'C--work', OLD, 'tool-results', 'big.txt'), 20)
  await put(at(roots.projects, 'C--work', `${OLD}.jsonl`), 20)
  await put(at(roots.projects, 'C--work', OLD, 'subagents', 'agent-1.jsonl'), 20)
  // A live session: kept even though its files are old.
  await put(at(roots.temp, 'abc123', LIVE, 'tasks', 'server.output'), 700)
  // A folder not named like a session: never touched.
  await put(at(roots.temp, 'abc123', 'not-a-session', 'tasks', 'x.output'), 10)
  await put(at(roots.temp, 'bundled-skills', '2.1.308', 'tasks', 'y.output'), 10)
  // A junction from a session's scratchpad to a folder outside: never followed.
  await put(at(outside, 'precious.txt'), 10)
  await mkdir(at(roots.temp, 'abc123', OTHER, 'scratchpad'), { recursive: true })
  await symlink(outside, at(roots.temp, 'abc123', OTHER, 'scratchpad', 'link'), 'junction')
  // And a whole tasks folder that is a junction.
  await mkdir(at(roots.temp, 'abc123', OTHER), { recursive: true })
  await symlink(outside, at(roots.temp, 'abc123', OTHER, 'tasks'), 'junction')

  const info = new Map<string, SessionInfo>([
    [OLD, { title: 'Old work', projectName: 'work', live: false, lastAt: NOW - 3 * DAY }],
    [LIVE, { title: 'Live work', projectName: 'work', live: true, lastAt: NOW }],
  ])
  const cleanup = async () => {
    // Junctions first: removing the tree must not reach through them.
    for (const link of [at(roots.temp, 'abc123', OTHER, 'scratchpad', 'link'), at(roots.temp, 'abc123', OTHER, 'tasks')]) await unlink(link).catch(() => {})
    await rm(base, { recursive: true, force: true })
  }
  return { base, roots, info, outside, at, cleanup }
}

test('reports only agent leftovers, and keeps what is active', async () => {
  const { roots, info, cleanup } = await setup()
  try {
    const r = await spaceReport(roots, info, NOW)
    assert.deepEqual(r.totals.tasks.free, { files: 1, bytes: 1000 })
    assert.deepEqual(r.totals.tasks.held, { files: 2, bytes: 750 })
    assert.deepEqual(r.totals.scratchpad.free, { files: 2, bytes: 500 })
    assert.deepEqual(r.totals.screenshots.free, { files: 1, bytes: 100 })
    assert.deepEqual(
      r.sessions.map(s => s.sessionId),
      [OLD, LIVE],
    )
    assert.equal(r.sessions[0]?.title, 'Old work')
  } finally {
    await cleanup()
  }
})

test('frees leftovers and nothing else', async () => {
  const { roots, info, outside, at, cleanup } = await setup()
  try {
    const result = await freeSpace(roots, info, { kinds: ['tasks', 'scratchpad', 'screenshots'] }, NOW)
    assert.equal(result.deleted, 4)
    assert.equal(result.bytes, 1600)
    assert.equal(result.held, 2)
    // Gone: the old session's leftovers, and the empty folder they were in.
    assert.equal(existsSync(at(roots.temp, 'abc123', OLD, 'tasks', 'b1.output')), false)
    assert.equal(existsSync(at(roots.temp, 'abc123', OLD, 'scratchpad', 'deep')), false)
    assert.equal(existsSync(at(roots.temp, 'abc123', OLD, 'scratchpad')), true)
    // Kept.
    for (const kept of [
      at(roots.temp, 'abc123', OLD, 'tasks', 'fresh.output'),
      at(roots.temp, 'abc123', OLD, 'images', '1.png'),
      at(roots.projects, 'C--work', OLD, 'tool-results', 'big.txt'),
      at(roots.projects, 'C--work', `${OLD}.jsonl`),
      at(roots.projects, 'C--work', OLD, 'subagents', 'agent-1.jsonl'),
      at(roots.temp, 'abc123', LIVE, 'tasks', 'server.output'),
      at(roots.temp, 'abc123', 'not-a-session', 'tasks', 'x.output'),
      at(roots.temp, 'bundled-skills', '2.1.308', 'tasks', 'y.output'),
      at(outside, 'precious.txt'),
    ]) {
      assert.equal(existsSync(kept), true, kept)
    }
  } finally {
    await cleanup()
  }
})

test('frees one kind of one session, and refuses bad requests', async () => {
  const { roots, info, at, cleanup } = await setup()
  try {
    const one = await freeSpace(roots, info, { kinds: ['screenshots'], sessionId: OLD }, NOW)
    assert.equal(one.deleted, 1)
    assert.equal(existsSync(at(roots.temp, 'abc123', OLD, 'tasks', 'b1.output')), true)
    const bad = await freeSpace(roots, info, { kinds: ['tasks'], sessionId: '../..' }, NOW)
    assert.equal(bad.deleted, 0)
    const unknown = await freeSpace(roots, info, { kinds: ['transcripts' as 'tasks'] }, NOW)
    assert.equal(unknown.deleted, 0)
  } finally {
    await cleanup()
  }
})
