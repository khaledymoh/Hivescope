import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Session } from './reader.ts'
import { Store } from './store.ts'

const t = (s: number) => new Date(Date.UTC(2026, 10, 10, 20, 0, s)).toISOString()
const use = (id: string, name: string, input: unknown, s: number) => ({ type: 'assistant', timestamp: t(s), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const answer = (id: string, s: number) => ({ type: 'user', timestamp: t(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] } })
const prompt = (text: string, s: number) => ({ type: 'user', timestamp: t(s), origin: { kind: 'human' }, message: { role: 'user', content: text } })

function session(records: unknown[]) {
  const s = new Session('aaaaaaaa-0000-4000-8000-00000000000a')
  for (const r of records) s.main.ingestLine(JSON.stringify(r))
  return s
}
const question = use('q1', 'AskUserQuestion', { questions: [{ question: 'Where should the workflow go?', options: [{ label: 'Global' }, { label: 'This project' }] }] }, 1)
const wrapAsk = use('w1', 'mcp__ccd_turn__wrap_up', { recap: 'Done.', ask: 'Fix the other bug too?', actions: [{ label: 'Yes, fix it' }, { label: 'Not now' }], blocked: true }, 2)

test('an open question dialog waits, until it is answered', () => {
  const open = session([question]).summary(Date.now()).waiting
  assert.equal(open?.kind, 'question')
  assert.equal(open?.text, 'Where should the workflow go?')
  assert.deepEqual(open?.options, ['Global', 'This project'])
  assert.equal(session([question, answer('q1', 3)]).summary(Date.now()).waiting, undefined)
})

test('a turn that ends with a question waits, until you write or it works again', () => {
  const asked = session([wrapAsk]).summary(Date.now()).waiting
  assert.equal(asked?.kind, 'asked')
  assert.equal(asked?.blocked, true)
  assert.deepEqual(asked?.options, ['Yes, fix it', 'Not now'])
  assert.equal(session([wrapAsk, prompt('yes', 5)]).summary(Date.now()).waiting, undefined)
  assert.equal(session([wrapAsk, use('b1', 'Bash', { command: 'ls' }, 6)]).summary(Date.now()).waiting, undefined)
  // A wrap-up with no question asks nothing.
  assert.equal(session([wrapAsk, use('w2', 'mcp__ccd_turn__wrap_up', { recap: 'Done.' }, 7)]).summary(Date.now()).waiting, undefined)
})

test('only a running session waits; its registry status adds dialogs and clears stale questions', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hivescope-wait-'))
  try {
    const dir = path.join(base, 'sessions')
    await mkdir(dir)
    const store = new Store(path.join(base, 'projects'), 7, dir)
    const asked = session([wrapAsk])
    // Not running: its question is from a closed chat.
    assert.equal(store.summaryOf(asked).waiting, undefined)
    const register = async (status: string, waitingFor?: string) => {
      await writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: asked.id, status, waitingFor, statusUpdatedAt: 5 }))
      await store.refreshRegistry()
    }
    await register('idle')
    assert.equal(store.summaryOf(asked).waiting?.kind, 'asked')
    assert.equal(store.summaryOf(asked).runState, 'idle')
    await register('busy')
    assert.equal(store.summaryOf(asked).waiting, undefined)
    await register('waiting', 'permission for Bash')
    assert.deepEqual(
      [store.summaryOf(asked).waiting?.kind, store.summaryOf(asked).waiting?.text],
      ['dialog', 'permission for Bash'],
    )
    // A process that has exited leaves its file; it counts as not running.
    await writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: 2 ** 22 + 12345, sessionId: asked.id, status: 'waiting' }))
    await store.refreshRegistry()
    assert.equal(store.summaryOf(asked).waiting, undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
