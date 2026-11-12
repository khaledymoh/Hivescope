// Synthetic transcript lines only: real transcripts hold private chat content.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { costOf } from '../shared/pricing.ts'
import { Session, Transcript } from './reader.ts'
import { cleanSettings, loadSettings, saveSettings, settingsPath } from './settings.ts'
import { Store } from './store.ts'
import { FIVE_HOURS, type SpendEvent, fiveHourBlocks, spendAlerts, usageOf } from './usage.ts'

const T0 = Date.parse('2026-11-08T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)

function assistant(id: string, s: number, blocks: unknown[], usage: Record<string, unknown>, model = 'claude-opus-5-5') {
  return JSON.stringify({ type: 'assistant', timestamp: at(s), cwd: 'C:\\work\\shop', sessionId: 's1', message: { id, model, role: 'assistant', content: blocks, usage } })
}
const user = (s: number, content: unknown) => JSON.stringify({ type: 'user', timestamp: at(s), cwd: 'C:\\work\\shop', sessionId: 's1', message: { role: 'user', content } })
const small = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 }
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })

test('prices match what Claude Code records for an Opus 5.5 session', () => {
  // Totals from a real session's cost record: Claude Code said $13.1033884.
  const cost = costOf('claude-opus-5-5', { input: 289_975, output: 97_558, cacheRead: 34_776_937, write5m: 380_449 - 378_232, write1h: 378_232 })
  near(cost, 13.1033884)
})

test('fast mode doubles the price; Haiku 5.5 costs five times as much past 100K of prompt', () => {
  const u = { input: 1000, output: 1000, cacheRead: 0, write5m: 0, write1h: 0 }
  near(costOf('claude-opus-5-5', u, 'fast'), 2 * costOf('claude-opus-5-5', u))
  const long = { ...u, cacheRead: 150_000 }
  near(costOf('claude-haiku-5-5', long), 5 * ((1000 * 0.1 + 1000 * 0.5 + 150_000 * 0.01) / 1e6))
  assert.equal(costOf('some-other-model', u), 0)
})

test('advisor passes are counted at the advisor model, cache writes split by lifetime, context from the last own pass', () => {
  const t = new Transcript('s1')
  const usage = {
    input_tokens: 4,
    output_tokens: 528,
    cache_read_input_tokens: 217_523,
    cache_creation_input_tokens: 1838,
    cache_creation: { ephemeral_1h_input_tokens: 677, ephemeral_5m_input_tokens: 0 },
    iterations: [
      { type: 'message', input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 108_423, cache_creation_input_tokens: 677, cache_creation: { ephemeral_1h_input_tokens: 677, ephemeral_5m_input_tokens: 0 } },
      { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 109_410, output_tokens: 6784, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 2, output_tokens: 502, cache_read_input_tokens: 109_100, cache_creation_input_tokens: 1161, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1161 } },
    ],
  }
  t.ingestLine(assistant('m1', 1, [{ type: 'text', text: 'hi' }], usage))
  // The same response split over another record: counted once.
  t.ingestLine(assistant('m1', 1, [{ type: 'server_tool_use', id: 'a', name: 'advisor', input: {} }], usage))

  const lead = costOf('claude-opus-5-5', { input: 2, output: 26, cacheRead: 108_423, write5m: 0, write1h: 677 }) + costOf('claude-opus-5-5', { input: 2, output: 502, cacheRead: 109_100, write5m: 1161, write1h: 0 })
  const advisor = costOf('claude-fable-5-2', { input: 109_410, output: 6784, cacheRead: 0, write5m: 0, write1h: 0 })
  near(t.tokensByModel['claude-opus-5-5']!.cost, lead)
  assert.equal(t.tokensByModel['claude-opus-5-5']!.output, 528)
  assert.equal(t.tokensByModel['claude-fable-5-2']!.output, 6784)
  near(t.advisorTokens.cost, advisor)
  near(t.cost, lead + advisor)
  assert.equal(t.contextTokens, 2 + 109_100 + 1161)
  assert.equal(t.spend.length, 3)
})

test('the same tool error twice is remembered; a declined permission is not', () => {
  const t = new Transcript('s1')
  t.ingestLine(assistant('m1', 1, [tool('t1', 'Bash', { command: 'npm test' })], small))
  t.ingestLine(user(2, [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1: 3 tests failed' }]))
  t.ingestLine(assistant('m2', 3, [tool('t2', 'Bash', { command: 'npm test' })], small))
  t.ingestLine(user(4, [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 1: 5 tests failed' }]))
  t.ingestLine(assistant('m3', 5, [tool('t3', 'Edit', { file_path: 'a.ts' })], small))
  t.ingestLine(user(6, [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: "The user doesn't want to proceed with this tool use." }]))
  const repeats = [...t.errorRepeats.values()]
  assert.equal(repeats.length, 1)
  assert.equal(repeats[0]!.tool, 'Bash')
  assert.equal(repeats[0]!.count, 2)
  assert.equal(t.errors, 3)
})

test('a run of lookups is a possible missed delegation, but reads of files the turn edits are not', () => {
  const s = new Session('s1')
  s.main.ingestLine(user(0, 'find where totals are computed'))
  // Six searches and reads in a row, each its own response.
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
  s.main.ingestLine(assistant('g', 1, [tool('g1', 'Grep', { pattern: 'total' })], small))
  files.forEach((f, i) => s.main.ingestLine(assistant(`r${i}`, 2 + i, [tool(`r${i}`, 'Read', { file_path: `C:\\work\\shop\\${f}` })], small)))
  let runs = s.main.missedRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.kind, 'lookups')
  assert.equal(runs[0]!.calls, 6)
  assert.equal(runs[0]!.suggest, 'quick')
  assert.ok(runs[0]!.cost > runs[0]!.cheapCost)

  // Then it edits three of those files: the reads were its own work, and only 3 lookups remain.
  ;['a.ts', 'b.ts', 'c.ts'].forEach((f, i) => s.main.ingestLine(assistant(`e${i}`, 10 + i, [tool(`e${i}`, 'Edit', { file_path: `c:/work/shop/${f}` })], small)))
  runs = s.main.missedRuns()
  assert.equal(runs.length, 0)
  assert.equal(s.summary(T0 + 60_000).missed, 0)
})

test('parallel lookups in one response are one step, and screenshots are not lookups', () => {
  const s = new Session('s1')
  s.main.ingestLine(user(0, 'look around'))
  const reads = ['a', 'b', 'c', 'd', 'e', 'f'].map(f => tool(`p${f}`, 'Read', { file_path: `C:\\work\\${f}.ts` }))
  s.main.ingestLine(assistant('one', 1, reads, small))
  assert.equal(s.main.missedRuns().length, 0)

  const shots = new Session('s2')
  shots.main.ingestLine(user(0, 'check the UI'))
  ;[1, 2, 3, 4, 5, 6].forEach(i => shots.main.ingestLine(assistant(`m${i}`, i, [tool(`t${i}`, 'Read', { file_path: `C:\\shots\\${i}.png` })], small)))
  assert.equal(shots.main.missedRuns().length, 0)
})

test('a weekly budget alerts once a day, not on every check', () => {
  const events: SpendEvent[] = [[T0, 50, 10, 'claude-opus-5-5']]
  const ids = (now: number) => spendAlerts(usageOf(events, now, { week: 40 }), now).map(a => a.id)
  assert.equal(ids(T0 + 1000).length, 1)
  assert.deepEqual(ids(T0 + 1000), ids(T0 + 60_000))
})

test('builds in the lead count from two in a turn, and never when the lead is already cheap', () => {
  const s = new Session('s1')
  s.main.ingestLine(user(0, 'run the tests'))
  s.main.ingestLine(assistant('b1', 1, [tool('b1', 'Bash', { command: 'npm test' })], small))
  s.main.ingestLine(assistant('b2', 2, [tool('b2', 'Bash', { command: 'npm run build' })], small))
  const runs = s.main.missedRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.kind, 'builds')
  assert.equal(runs[0]!.suggest, 'worker')

  const cheap = new Session('s2')
  cheap.main.ingestLine(user(0, 'run the tests'))
  cheap.main.ingestLine(assistant('b1', 1, [tool('b1', 'Bash', { command: 'npm test' })], small, 'claude-sonnet-5-5'))
  cheap.main.ingestLine(assistant('b2', 2, [tool('b2', 'Bash', { command: 'npm test' })], small, 'claude-sonnet-5-5'))
  assert.equal(cheap.main.missedRuns().length, 0)
})

test('5-hour windows start at the hour of the first message after the last one ended', () => {
  const h = 3_600_000
  const base = Date.parse('2026-11-08T09:00:00.000Z')
  const events: SpendEvent[] = [
    [base + 20 * 60_000, 1, 10, 'claude-opus-5-5'],
    [base + 4 * h, 2, 10, 'claude-opus-5-5'],
    [base + 5 * h + 1, 4, 10, 'claude-sonnet-5-5'],
  ]
  const blocks = fiveHourBlocks(events)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]!.start, base)
  assert.equal(blocks[0]!.cost, 3)
  assert.equal(blocks[1]!.start, base + 5 * h)
  assert.equal(blocks[1]!.byModel['claude-sonnet-5-5'], 4)

  // Now is inside the second window: it's the current one.
  const now = base + 6 * h
  const usage = usageOf(events, now, { fiveHour: 3 })
  assert.equal(usage.fiveHour?.start, base + 5 * h)
  assert.equal(usage.fiveHour?.end, base + 5 * h + FIVE_HOURS)
  assert.equal(usage.fiveHour?.cost, 4)

  const alerts = spendAlerts(usage, now)
  assert.deepEqual(alerts.map(a => a.kind), ['budget'])
  // The same state gives the same ids, so each alert is notified once.
  assert.deepEqual(spendAlerts(usage, now + 1000).map(a => a.id), alerts.map(a => a.id))
})

test('alerts: a full context, a repeated error, a quiet subagent; only for recent sessions', () => {
  const store = new Store('unused', 7)
  const now = T0 + 20 * 60_000
  const s = new Session('s1')
  store.sessions.set('s1', s)
  s.main.ingestLine(user(0, 'go'))
  s.main.ingestLine(assistant('m1', 1, [tool('t1', 'Bash', { command: 'ls' })], { ...small, cache_read_input_tokens: 850_000 }))
  s.main.ingestLine(user(2, [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }]))
  s.main.ingestLine(assistant('m2', 3, [tool('t2', 'Bash', { command: 'ls' })], { ...small, cache_read_input_tokens: 860_000 }))
  s.main.ingestLine(user(4, [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }]))
  const agent = s.agent('a1', { agentType: 'worker', description: 'run the build' })
  agent.ingestLine(assistant('x1', 5, [tool('x', 'Bash', { command: 'gradlew build' })], small, 'claude-sonnet-5-5'))

  const kinds = store.alerts(now).map(a => a.kind).sort()
  assert.deepEqual(kinds, ['context', 'error', 'stalled'])
  // An hour later the session is history: no alerts.
  assert.deepEqual(store.alerts(T0 + 2 * 3_600_000), [])
})

test('budgets: only positive numbers are kept, and they survive a save and load', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hivescope-settings-'))
  try {
    const file = settingsPath(dir)
    assert.deepEqual(await loadSettings(file), { budgets: {} })
    const clean = cleanSettings({ budgets: { fiveHour: 5, day: -1, week: 'x' } })
    assert.deepEqual(clean, { budgets: { fiveHour: 5, day: undefined, week: undefined } })
    await saveSettings(file, clean)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { budgets: { fiveHour: 5 } })
    assert.equal((await loadSettings(file)).budgets.fiveHour, 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
