// Synthetic transcript lines only: real transcripts hold private chat content.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Session, Transcript, applyTaskUpdate, describeCall, shortModel, shouldSkip } from './reader.ts'
import { Store } from './store.ts'

const T0 = Date.parse('2026-11-08T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 }

function assistant(id: string, s: number, blocks: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    message: { model: 'claude-sonnet-5-5', id, role: 'assistant', content: blocks, usage },
    type: 'assistant',
    timestamp: at(s),
    advisorModel: 'claude-opus-5-5',
    cwd: 'C:\\work\\shop-app',
    sessionId: 's1',
    entrypoint: 'claude-desktop',
    ...extra,
  })
}
const user = (s: number, content: unknown) =>
  JSON.stringify({ parentUuid: 'p', type: 'user', message: { role: 'user', content }, timestamp: at(s), cwd: 'C:\\work\\shop-app', sessionId: 's1' })

const LINES = [
  JSON.stringify({ type: 'api-request-blob', sessionId: 's1', hash: 'x', message: { huge: true } }),
  user(0, 'fix the login bug'),
  user(1, '<system-reminder>ignore me</system-reminder>'),
  // One response split over three records that repeat the same usage.
  assistant('m1', 2, [{ type: 'text', text: 'Plan: patch auth then run tests.' }], { apiBlockIndex: 0 }),
  assistant('m1', 2, [{ type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} }], { apiBlockIndex: 1 }),
  assistant('m1', 3, [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'C:\\work\\auth.ts' } }], { apiBlockIndex: 2 }),
  user(4, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
  assistant('m2', 5, [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'worker', description: 'run tests' } }]),
  user(6, [{ type: 'tool_result', tool_use_id: 'tu2', content: 'boom', is_error: true }]),
  JSON.stringify({ type: 'custom-title', customTitle: 'Login bug', sessionId: 's1' }),
  '{"broken json',
]

test('reads a session: prompts, tools, advisor, tokens counted once per response', () => {
  const t = new Transcript('s1')
  for (const line of LINES) t.ingestLine(line)
  assert.equal(t.prompts, 1)
  assert.equal(t.toolCalls, 2)
  assert.deepEqual(t.toolMix, { Edit: 1, Agent: 1 })
  assert.equal(t.errors, 1)
  assert.equal(t.title, 'Login bug')
  assert.equal(t.advisor.length, 1)
  assert.equal(t.advisor[0]!.about, 'Plan: patch auth then run tests.')
  // Two responses (m1, m2), not four records.
  assert.equal(t.tokensByModel['claude-sonnet-5-5']!.output, 100)
  assert.equal(t.contextTokens, 1110)
  assert.equal(t.spawns.get('tu2')?.type, 'worker')
  assert.equal(t.effort, undefined)
  t.ingestLine(assistant('m3', 7, [{ type: 'text', text: 'done' }], { effort: 'high' }))
  assert.equal(t.effort, 'high')
})

test('advisor with no text before it falls back to the last action', () => {
  const t = new Transcript('s1')
  t.ingestLine(assistant('a', 1, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }]))
  t.ingestLine(assistant('b', 2, [{ type: 'server_tool_use', id: 'srv', name: 'advisor', input: {} }]))
  assert.equal(t.advisor[0]!.about, 'after Bash npm test')
})

test('subagent links to its spawn through meta toolUseId', () => {
  const s = new Session('s1')
  for (const line of LINES) s.main.ingestLine(line)
  const sub = s.agent('ag1', { agentType: 'worker', toolUseId: 'tu2', finished: true })
  sub.ingestLine(assistant('x1', 30, [{ type: 'tool_use', id: 'q', name: 'Bash', input: { command: 'npm test' } }], { isSidechain: true }))
  const [run] = s.subagents(T0 + 60_000)
  assert.equal(run?.type, 'worker')
  assert.equal(run?.description, 'run tests')
  assert.equal(run?.status, 'done')
  assert.equal(run?.startedAt, T0 + 5000)
  assert.equal(run?.lastAction, 'Bash npm test')
  assert.deepEqual(run?.recent.map(r => r.text), ['Bash npm test'])
  assert.deepEqual(s.agentLog('ag1')?.map(e => e.text), ['Bash npm test'])
  assert.equal(s.agentLog('missing'), undefined)
  const summary = s.summary(T0 + 60_000)
  assert.equal(summary.projectName, 'shop-app')
  assert.equal(summary.subagentsTotal, 1)
  assert.equal(summary.status, 'live')
})

test('context size uses the last pass when usage sums several', () => {
  const t = new Transcript('s1')
  const line = JSON.parse(assistant('m9', 1, [{ type: 'text', text: 'hi' }])) as { message: { usage: Record<string, unknown> } }
  line.message.usage = {
    input_tokens: 2,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 0,
    output_tokens: 40,
    iterations: [
      { input_tokens: 1, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 20 },
      { input_tokens: 1, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 20 },
    ],
  }
  t.ingestLine(JSON.stringify(line))
  assert.equal(t.contextTokens, 401)
  assert.equal(t.tokensByModel['claude-sonnet-5-5']!.cacheRead, 800)
})

test('task list: replace, advance, done/start, wrap-up', () => {
  const tool = 'mcp__ccd_turn__update_plan'
  let list = applyTaskUpdate(undefined, tool, { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, 1)
  assert.deepEqual(list?.items.map(i => i.status), ['in_progress', 'pending', 'pending'])
  list = applyTaskUpdate(list, tool, { advance: true }, 2)
  assert.deepEqual(list?.items.map(i => i.status), ['completed', 'in_progress', 'pending'])
  list = applyTaskUpdate(list, tool, { done: [2], start: 3 }, 3)
  assert.deepEqual(list?.items.map(i => i.status), ['completed', 'completed', 'in_progress'])
  list = applyTaskUpdate(list, 'mcp__ccd_turn__wrap_up', { recap: 'All done.' }, 4)
  assert.deepEqual(list?.items.map(i => i.status), ['completed', 'completed', 'completed'])
  assert.equal(list?.recap, 'All done.')
  // A new list starts fresh, without the old recap.
  list = applyTaskUpdate(list, tool, { items: [{ content: 'D', status: 'in_progress' }] }, 5)
  assert.equal(list?.recap, undefined)
  // The terminal's TodoWrite.
  const todo = applyTaskUpdate(undefined, 'TodoWrite', { todos: [{ content: 'X', status: 'completed', activeForm: 'Doing X' }] }, 6)
  assert.deepEqual(todo?.items, [{ content: 'X', status: 'completed' }])
})

test('the lead keeps its task list, last words, and real last step', () => {
  const t = new Transcript('s1')
  t.ingestLine(assistant('p1', 1, [{ type: 'tool_use', id: 'u1', name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'Look', status: 'in_progress' }] } }]))
  t.ingestLine(assistant('p2', 2, [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'ls src', description: 'List the source files' } }]))
  t.ingestLine(assistant('p3', 3, [{ type: 'text', text: 'Found it. Fixing now.' }, { type: 'tool_use', id: 'u3', name: 'mcp__ccd_turn__update_plan', input: { advance: true } }]))
  assert.equal(t.lastAction, 'Bash · List the source files')
  assert.equal(t.lastSaid?.text, 'Found it. Fixing now.')
  assert.deepEqual(t.tasks?.items, [{ content: 'Look', status: 'completed' }])
})

test("a subagent's hand-back is its result", () => {
  const t = new Transcript('s1', 'ag1', 'worker')
  t.ingestLine(assistant('h1', 1, [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'Summary: 3 of 4 pages read.' } }]))
  assert.deepEqual(t.lastSaid, { at: T0 + 1000, text: 'Summary: 3 of 4 pages read.', result: true })
  assert.equal(t.lastAction, 'handed its result back to the lead')
})

test('helpers', () => {
  assert.equal(shouldSkip('{"type":"file-history-snapshot","x":1}'), true)
  assert.equal(shouldSkip('{"parentUuid":"x","type":"assistant"}'), false)
  assert.equal(describeCall('Edit', { file_path: 'C:\\a\\b.ts' }), 'Edit b.ts')
  assert.equal(describeCall('SubagentHandback', { result: 'x' }), 'handed its result back to the lead')
  assert.equal(shortModel('claude-haiku-5-5'), 'haiku 5.5')
})

test('store reads appended lines, keeps half-written lines, and links subagent files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hivescope-'))
  try {
    const project = path.join(root, 'C--work-shop-app')
    await mkdir(path.join(project, 's1', 'subagents'), { recursive: true })
    const main = path.join(project, 's1.jsonl')
    await writeFile(main, LINES.slice(0, 4).join('\n') + '\n' + LINES[4]!.slice(0, 20))
    const store = new Store(root, 7)
    assert.equal(await store.scan(), true)
    assert.equal(store.sessions.get('s1')?.main.advisor.length, 0)

    await appendFile(main, LINES[4]!.slice(20) + '\n' + LINES.slice(5).join('\n') + '\n')
    assert.equal(await store.changed(main), true)
    const s = store.sessions.get('s1')!
    assert.equal(s.main.advisor.length, 1)
    assert.equal(s.main.toolCalls, 2)

    const sub = path.join(project, 's1', 'subagents', 'agent-ag1.jsonl')
    await writeFile(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'worker', toolUseId: 'tu2', finished: false }))
    await writeFile(sub, assistant('x1', 30, [{ type: 'tool_use', id: 'q', name: 'Bash', input: { command: 'npm test' } }]) + '\n')
    await store.scan()
    const overview = store.overview()
    assert.equal(overview.sessions.length, 1)
    assert.equal(overview.sessions[0]!.subagentsTotal, 1)
    assert.ok(overview.log.some(e => e.who === 'worker'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
