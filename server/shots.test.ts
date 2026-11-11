// Uses throwaway folders only: never the real ~/.claude or temp folders.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { deleteShots, listOpened, listShots, resolveShot, summarize } from './shots.ts'

async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hivescope-shots-'))
  const roots = { projects: path.join(base, 'projects'), temp: path.join(base, 'temp') }
  const put = async (file: string, bytes = 10) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Buffer.alloc(bytes))
  }
  await put(path.join(roots.projects, 'C--work', 's1', 'tool-results', 'mcp-browser-blob-1.jpg'), 100)
  await put(path.join(roots.projects, 'C--work', 's1', 'tool-results', 'notes.txt'), 5)
  await put(path.join(roots.temp, 'abc123', 's1', 'scratchpad', 'shot.png'), 300)
  await put(path.join(roots.temp, 'abc123', 's1', 'scratchpad', 'deep', 'more.webp'), 50)
  await put(path.join(roots.temp, 'abc123', 's1', 'images', '1.png'), 20)
  await put(path.join(roots.temp, 'abc123', 's2', 'scratchpad', 'other.png'), 70)
  // Not a screenshot folder: never listed or deletable.
  await put(path.join(roots.projects, 'C--work', 's1', 'subagents', 'x.png'), 1)
  return { base, roots }
}

test('lists screenshots by kind and session, nothing else', async () => {
  const { base, roots } = await setup()
  try {
    const files = await listShots(roots)
    assert.deepEqual(files.map(f => `${f.sessionId}/${f.kind}/${f.name}`).sort(), [
      's1/pasted/1.png',
      's1/scratchpad/more.webp',
      's1/scratchpad/shot.png',
      's1/tool/mcp-browser-blob-1.jpg',
      's2/scratchpad/other.png',
    ])
    const [first] = summarize(files, new Map([['s1', { title: 'Shop', projectName: 'work', live: false }]]))
    assert.equal(first?.sessionId, 's1')
    assert.equal(first?.bytes, 470)
    assert.equal(first?.byKind.scratchpad.count, 2)
    assert.equal(first?.title, 'Shop')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('refuses ids outside the screenshot folders', async () => {
  const { base, roots } = await setup()
  try {
    const forge = (s: string) => Buffer.from(s).toString('base64url')
    assert.equal(resolveShot(roots, forge('projects:C--work/s1/subagents/x.png')), undefined)
    assert.equal(resolveShot(roots, forge('temp:../../etc/x.png')), undefined)
    assert.equal(resolveShot(roots, forge('projects:C--work/s1/tool-results/notes.txt')), undefined)
    assert.equal(resolveShot(roots, forge('home:x/y/z/a.png')), undefined)
    assert.equal(resolveShot(roots, 'not base64 !!'), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('deletes only what it may: pasted images need permission', async () => {
  const { base, roots } = await setup()
  try {
    const files = await listShots(roots)
    const ids = files.filter(f => f.sessionId === 's1').map(f => f.id)
    const first = await deleteShots(roots, ids, { pasted: false })
    assert.equal(first.deleted, 3)
    assert.equal(first.skipped, 1)
    assert.equal(existsSync(path.join(roots.temp, 'abc123', 's1', 'images', '1.png')), true)
    assert.equal(existsSync(path.join(roots.temp, 'abc123', 's2', 'scratchpad', 'other.png')), true)
    const second = await deleteShots(roots, ids, { pasted: true })
    assert.equal(second.deleted, 1)
    assert.equal(existsSync(path.join(roots.projects, 'C--work', 's1', 'tool-results', 'notes.txt')), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('images opened elsewhere are served only for the session that opened them, and never deleted', async () => {
  const { base, roots } = await setup()
  try {
    const project = path.join(base, 'myproject', 'build')
    await mkdir(project, { recursive: true })
    const shot = path.join(project, '01-home.png')
    await writeFile(shot, Buffer.alloc(40))
    const secret = path.join(project, 'notes.txt')
    await writeFile(secret, 'x')
    const opened = new Map([[shot, 1], [secret, 2], [path.join(roots.temp, 'abc123', 's1', 'scratchpad', 'shot.png'), 3]])
    const files = await listOpened(roots, 's1', opened)
    // Only the image outside Claude's folders (the scratchpad one is listed already; text is never an image).
    assert.deepEqual(files.map(f => f.name), ['01-home.png'])
    const id = files[0]!.id
    const check = (sid: string, f: string) => sid === 's1' && opened.has(f)
    assert.equal(resolveShot(roots, id, check)?.file, shot)
    // Another session can't borrow it, a forged path isn't served, and without the check nothing resolves.
    const forge = (s: string) => Buffer.from(s).toString('base64url')
    assert.equal(resolveShot(roots, forge(`opened:s2|${shot}`), check), undefined)
    assert.equal(resolveShot(roots, forge(`opened:s1|${path.join(base, 'other.png')}`), check), undefined)
    assert.equal(resolveShot(roots, forge(`opened:s1|${secret}`), check), undefined)
    const r = await deleteShots(roots, [id], { pasted: true })
    assert.equal(r.deleted, 0)
    assert.equal(existsSync(shot), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
