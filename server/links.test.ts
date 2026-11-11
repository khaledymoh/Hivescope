import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveLinks } from './links.ts'
import { Transcript } from './reader.ts'

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const PIPE = 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-1385'
const t = (s: number) => new Date(Date.UTC(2026, 10, 9, 21, 0, s)).toISOString()

function read(sessionId: string, records: unknown[]) {
  const tr = new Transcript(sessionId)
  for (const r of records) tr.ingestLine(JSON.stringify(r))
  return tr
}
const use = (id: string, name: string, input: unknown, s: number) => ({ type: 'assistant', timestamp: t(s), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, out: unknown, s: number) => ({
  type: 'user',
  timestamp: t(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(out) }] }] },
  toolUseResult: out,
})
const peer = (origin: Record<string, unknown>, s: number) => ({
  type: 'user',
  timestamp: t(s),
  origin: { kind: 'peer', ...origin },
  message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message>${String(origin.body)}</cross-session-message>` },
})

// A messages B through a pipe address, then messages its own subagent; B replies by name; a subagent hands back to B.
const a = read(A, [
  { type: 'custom-title', customTitle: 'Admin panel', sessionId: A },
  use('t1', 'SendMessage', { to: PIPE, recipient_kind: 'session', summary: 'Claim admin files', message: 'I am editing admin/ now.' }, 1),
  result('t1', { success: true, message: '“Claim admin files” → uds:… in that session’s inbox', msg_id: 'msg-1' }, 2),
  use('t2', 'SendMessage', { to: 'a5d302e372267a1d9', recipient_kind: 'agent', message: 'keep going' }, 3),
  peer({ from: 'uds:pipe-b', fromSession: 'local_bbbbbbbb-1111-4111-8111-111111111111', name: 'Android app', msg_id: 'msg-2', body: 'Fine, admin/ is yours.' }, 6),
  use('t3', 'SendMessage', { to: 'Old session', recipient_kind: 'name', summary: 'Ping old', message: 'Still there?' }, 7),
  result('t3', { success: false, message: 'Failed to send: No running session has registered an inbox (ENOINBOX)' }, 8),
])
const b = read(B, [
  { type: 'custom-title', customTitle: 'Android app', sessionId: B },
  peer({ from: PIPE, fromSession: 'local_aaaaaaaa-1111-4111-8111-111111111111', name: 'Admin panel', msg_id: 'msg-1', body: 'I am editing admin/ now.' }, 2),
  use('t9', 'SendMessage', { to: 'Admin panel', recipient_kind: 'name', summary: 'Ack', message: 'Fine, admin/ is yours.' }, 5),
  result('t9', { success: true, message: '“Ack” → Admin panel (another Claude session on this machine; …)', msg_id: 'msg-2' }, 6),
  peer({ from: 'a5d302e372267a1d9', senderTaskId: 'a5d302e372267a1d9', name: 'worker', body: '[Subagent hand-back] report' }, 9),
  // From a session whose transcript isn't loaded.
  peer({ from: 'uds:pipe-x', fromSession: 'local_cccccccc-1111-4111-8111-111111111111', name: 'Gone session', msg_id: 'msg-9', body: 'Hello from far away' }, 10),
])

test('reads sent and received messages, not subagent traffic', () => {
  assert.deepEqual(
    a.links.map(l => `${l.kind}:${l.msgId ?? '-'}:${l.ok ?? ''}`),
    ['sent:msg-1:true', 'received:msg-2:', 'sent:-:false'],
  )
  assert.equal(a.links[2]?.error?.includes('ENOINBOX'), true)
  assert.deepEqual(
    b.links.map(l => `${l.kind}:${l.peerName}`),
    ['received:Admin panel', 'sent:Admin panel', 'received:Gone session'],
  )
  // Messages from other sessions are not the person's prompts.
  assert.equal(b.prompts, 0)
})

test('joins both sides by message id and names the other session', () => {
  const { bySession, edges } = resolveLinks([
    { sessionId: A, title: 'Admin panel', links: a.links },
    { sessionId: B, title: 'Android app', links: b.links },
  ])
  const la = bySession.get(A)!
  // Sent to a pipe address: found through the message id.
  assert.equal(la[0]?.peerSessionId, B)
  assert.equal(la[0]?.peerTitle, 'Android app')
  assert.equal(la[1]?.peerSessionId, B)
  // Failed, to a session that isn't here: left unnamed.
  assert.equal(la[2]?.peerSessionId, undefined)
  const lb = bySession.get(B)!
  assert.equal(lb[0]?.peerSessionId, A)
  // The receiver gets the sender's one-line summary.
  assert.equal(lb[0]?.summary, 'Claim admin files')
  // Not loaded: keeps the name the message carried.
  assert.equal(lb[2]?.peerSessionId, undefined)
  assert.equal(lb[2]?.peerName, 'Gone session')
  // Each message counted once, from its sender.
  assert.deepEqual(edges.map(e => `${e.from === A ? 'A' : 'B'}>${e.to === A ? 'A' : 'B'}:${e.count}`).sort(), ['A>B:1', 'B>A:1'])
})

test('the running sessions registry names a desktop id', () => {
  const { bySession } = resolveLinks(
    [
      { sessionId: B, title: 'Android app', links: b.links },
      { sessionId: 'cccccccc-0000-4000-8000-00000000000c', title: 'Renamed since', links: [] },
    ],
    [{ sessionId: 'cccccccc-0000-4000-8000-00000000000c', hostSessionId: 'local_cccccccc-1111-4111-8111-111111111111' }],
  )
  assert.equal(bySession.get(B)![2]?.peerSessionId, 'cccccccc-0000-4000-8000-00000000000c')
})
