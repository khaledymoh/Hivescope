import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type SessionSummary, contextWindow } from '../../shared/types'
import { groupSessions } from './groups'

const NOW = new Date(2026, 10, 10, 12, 0).getTime()
const base: SessionSummary = {
  id: '',
  cwd: '',
  projectName: '',
  title: '',
  entrypoint: '',
  startedAt: 0,
  lastAt: 0,
  status: 'idle',
  prompts: 0,
  toolCalls: 0,
  errors: 0,
  advisorCalls: 0,
  subagentsRunning: 0,
  subagentsTotal: 0,
  contextTokens: 0,
  outputTokens: 0,
  cost: 0,
  advisorCost: 0,
  missed: 0,
  missedCost: 0,
  lastAction: '',
  talks: 0,
}
const s = (id: string, cwd: string, status: SessionSummary['status'], hoursAgo: number): SessionSummary => ({
  ...base,
  id,
  cwd,
  projectName: cwd.split('\\').pop()!,
  status,
  lastAt: NOW - hoursAgo * 3_600_000,
})

// Newest first, as the server sends them.
const SESSIONS = [
  s('a', 'H:\\demo-game', 'live', 0),
  s('b', 'C:\\Users\\me', 'recent', 0.2),
  s('c', 'H:\\demo-game', 'idle', 20),
  s('d', 'D:\\old\\app', 'idle', 30),
  s('e', 'H:\\work\\app', 'idle', 50),
]

test('groups by project, newest project first, telling apart same-named folders', () => {
  const groups = groupSessions(SESSIONS, 'project', NOW)
  assert.deepEqual(
    groups.map(g => [g.label, g.sessions.map(x => x.id).join(''), g.live]),
    [
      ['demo-game', 'ac', 1],
      ['me', 'b', 0],
      ['old\\app', 'd', 0],
      ['work\\app', 'e', 0],
    ],
  )
})

test('groups by status in a fixed order, and by day with friendly names', () => {
  assert.deepEqual(
    groupSessions(SESSIONS, 'status', NOW).map(g => [g.label, g.sessions.length]),
    [
      ['Live now', 1],
      ['Last 30 minutes', 1],
      ['Earlier', 3],
    ],
  )
  const days = groupSessions(SESSIONS, 'day', NOW).map(g => g.label)
  assert.equal(days[0], 'Today')
  assert.equal(days[1], 'Yesterday')
  assert.equal(days.length, 3)
})

test('context window per model', () => {
  assert.equal(contextWindow('claude-opus-5-5'), 1_000_000)
  assert.equal(contextWindow('claude-sonnet-5-5'), 1_000_000)
  assert.equal(contextWindow('claude-haiku-5-5'), 1_000_000)
  assert.equal(contextWindow('claude-fable-5-1'), 1_000_000)
  assert.equal(contextWindow('claude-haiku-4-5'), 200_000)
  assert.equal(contextWindow('claude-sonnet-4-5'), 200_000)
  assert.equal(contextWindow('claude-opus-4-6'), 1_000_000)
  assert.equal(contextWindow('claude-sonnet-4-5[1m]'), 1_000_000)
})

test('sessions waiting on you get their own group, first', () => {
  const waiting = { ...SESSIONS[3]!, waiting: { kind: 'question' as const, text: 'Which file?', at: NOW } }
  const groups = groupSessions([SESSIONS[0]!, waiting], 'status', NOW)
  assert.deepEqual(
    groups.map(g => [g.label, g.sessions.map(x => x.id).join('')]),
    [
      ['Waiting for you', 'd'],
      ['Live now', 'a'],
    ],
  )
})

test('no grouping keeps one list', () => {
  const [all] = groupSessions(SESSIONS, 'none', NOW)
  assert.equal(all?.sessions.length, 5)
})
