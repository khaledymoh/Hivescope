import { useState } from 'react'

import { COMPACT_AT, type LogEvent, type SessionDetail, type SubagentRun, type TaskList, type Waiting, contextWindow } from '../../shared/types'
import { useLive } from './api'
import { LiveLog } from './parts'
import { C, ago, duration, family, hms, modelColor, shortModel, tokens } from './theme'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MAX_CELLS = 4

/** Hexagon badge used for every node. */
function Hex({ color, size = 18, filled = true }: { color: string; size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className="hex">
      <path d="M16 2l12 7v14l-12 7-12-7V9z" fill={filled ? color : 'none'} stroke={color} strokeWidth={filled ? 0 : 2.5} />
    </svg>
  )
}

function EffortPips({ effort }: { effort?: string }) {
  const level = effort ? EFFORTS.indexOf(effort) + 1 : 0
  if (!level) return null
  return (
    <span className="pips" title={`Reasoning effort: ${effort}`}>
      {EFFORTS.map((e, i) => (
        <i key={e} className={i < level ? 'on' : ''} />
      ))}
      <span className="pips-l">{effort}</span>
    </span>
  )
}

/** Why the flag sits at 40%, with this session's own numbers. */
function WhyCompact({ used, window }: { used: number; window: number }) {
  const line = Math.round(COMPACT_AT * 100)
  return (
    <details className="why">
      <summary>Why compact at {line}%?</summary>
      <ul>
        <li>
          <b>Sharper answers.</b> The longer the conversation, the more old detail Claude has to sift through. Early instructions and decisions get less
          attention, and stale information (old file contents, abandoned approaches) can steer it wrong. A compacted summary keeps what matters and drops the
          noise.
        </li>
        <li>
          <b>Every step re-reads everything.</b> Each tool call sends the whole conversation again: right now that's about {tokens(used)} tokens per step. Even
          with caching, that adds cost (or uses up your plan's limits faster) and makes each step slower to start.
        </li>
        <li>
          <b>You choose what's kept.</b> Compacting at a natural break, such as when a task is done, keeps the summary clean. Waiting until the window is
          nearly full ({tokens(window)}) means compaction can happen mid-task, where in-progress details are more likely to get lost.
        </li>
        <li>
          <b>Room to work.</b> Compacting early leaves plenty of space for big file reads, logs and subagent results without hitting the limit.
        </li>
      </ul>
      <h4 className="why-h">How</h4>
      <p className="why-how">
        Run <code>/compact</code> in that chat, or start a fresh one.
      </p>
      <p className="why-note">
        {line}% is a rule of thumb, not an official limit: a session still works above it. It's set by <code>COMPACT_AT</code> in <code>shared/types.ts</code>.
      </p>
    </details>
  )
}

/** How full the context window is, with a mark at the compact line and a red flag past it. */
function ContextMeter({ tokens: used, model }: { tokens: number; model?: string }) {
  if (!used) return null
  const window = contextWindow(model)
  const share = used / window
  const over = share >= COMPACT_AT
  const level = over ? 'over' : share >= COMPACT_AT * 0.75 ? 'near' : 'ok'
  return (
    <div className={`ctx ${level}`}>
      <div className="ctx-h">
        <span>Context</span>
        <b>{Math.round(share * 100)}%</b>
        <span className="dim">
          {tokens(used)} of {tokens(window)}
        </span>
      </div>
      <div className="ctx-bar" title={`Compact at ${Math.round(COMPACT_AT * 100)}%`}>
        <span className="ctx-fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
        <span className="ctx-mark" style={{ left: `${COMPACT_AT * 100}%` }} title={`Compact line: ${Math.round(COMPACT_AT * 100)}%`} />
      </div>
      {over && (
        <div className="ctx-flag" role="alert">
          <span className="ctx-flag-icon" aria-hidden>
            ⚑
          </span>
          <div>
            <b>Compact this session.</b> {Math.round(share * 100)}% of the context window is used.
            <WhyCompact used={used} window={window} />
          </div>
        </div>
      )}
    </div>
  )
}

/** The task list as the app shows it: a spinner on the running step, rings for pending, checks for done. */
function TaskChecklist({ tasks }: { tasks?: TaskList }) {
  if (!tasks || (tasks.items.length === 0 && !tasks.recap)) return null
  const done = tasks.items.filter(i => i.status === 'completed').length
  return (
    <div className="tasks">
      {tasks.items.length > 0 && (
        <div className="tasks-h">
          <span>Tasks</span>
          <span className="tasks-count">
            {done}/{tasks.items.length}
          </span>
          <span className="tasks-bar">
            <span style={{ width: `${(100 * done) / tasks.items.length}%` }} />
          </span>
        </div>
      )}
      <ol className="tasks-list">
        {tasks.items.map((item, i) => (
          <li key={i} className={item.status}>
            <span className="tick" aria-label={item.status.replace('_', ' ')} />
            <span>{item.content}</span>
          </li>
        ))}
      </ol>
      {tasks.recap && <p className="recap">{tasks.recap}</p>}
    </div>
  )
}

const WAIT_TITLE: Record<Waiting['kind'], string> = {
  question: 'Waiting for your answer',
  plan: 'Waiting for you to approve its plan',
  dialog: 'Waiting for you',
  asked: 'Asked you',
}

/** What the session waits on you for, and the answers it offers. Answer it in that chat. */
export function WaitingBox({ waiting }: { waiting?: Waiting }) {
  if (!waiting) return null
  const urgent = waiting.blocked || waiting.kind !== 'asked'
  return (
    <div className={`waiting ${urgent ? 'urgent' : ''}`} role="status">
      <div className="waiting-h">
        <span className="waiting-icon" aria-hidden>
          ✋
        </span>
        <b>{WAIT_TITLE[waiting.kind]}</b>
        {waiting.kind === 'dialog' && <span className="waiting-why">{waiting.text}</span>}
        <span className="grow" />
        <span className="dim">{ago(waiting.at)}</span>
      </div>
      {waiting.kind !== 'dialog' && <p className="waiting-text">{waiting.text}</p>}
      {waiting.options && waiting.options.length > 0 && (
        <div className="waiting-options">
          {waiting.options.map(o => (
            <span key={o} className="waiting-option">
              {o}
            </span>
          ))}
        </div>
      )}
      <span className="waiting-foot">
        {waiting.kind === 'asked' && !waiting.blocked ? 'It can carry on without an answer. ' : 'It can’t go on until you answer. '}
        Answer in that chat.
      </span>
    </div>
  )
}

/** What Claude last wrote, clamped; the full text on hover. */
function Says({ said, lines = 3 }: { said?: { at: number; text: string; result?: boolean }; lines?: number }) {
  if (!said) return null
  return (
    <div className={`says ${said.result ? 'result' : ''}`} title={said.text}>
      <span className="says-l">
        {said.result ? 'result for the lead' : 'says'} · {ago(said.at)}
      </span>
      <p style={{ WebkitLineClamp: lines }}>{said.text}</p>
    </div>
  )
}

/** Everything one subagent did, newest first, under the cells; the brief it was given on top. */
function AgentLog({ s, run, onClose }: { s: SessionDetail; run?: SubagentRun; onClose: () => void }) {
  // Refetched whenever this subagent does something new.
  const events = useLive<LogEvent[]>(run ? `/api/session/${s.id}/agent/${run.id}` : undefined, run ? run.toolCalls * 1e6 + (run.endedAt ?? 0) : 0)
  if (!run) return null
  if (!events) return <div className="agent-log">Loading the log…</div>
  const brief = events.find(e => e.kind === 'prompt')
  const color = modelColor(run.model)
  return (
    <div className="agent-log" style={{ ['--c' as string]: color }}>
      <div className="agent-log-h">
        <Hex color={color} size={15} />
        <b>{run.type}</b>
        <span style={{ color }}>{shortModel(run.model)}</span>
        <span className="dim">· {run.description}</span>
        <span className="grow" />
        <span className={`pill ${run.status === 'running' ? 'run' : 'ok'}`}>{run.status}</span>
        <button className="close" onClick={onClose} aria-label="Close the log">
          ✕
        </button>
      </div>
      {brief ? (
        <p className="agent-brief">
          <span className="dim">Brief from the lead: </span>
          {brief.text.replace(/^prompt: /, '')}
        </p>
      ) : (
        // A fork starts from a copy of the lead's whole conversation instead of a written brief.
        <p className="agent-brief">
          <span className="dim">{run.type === 'fork' ? 'Forked from the lead’s conversation to: ' : 'Task: '}</span>
          {run.description || 'no description'}
        </p>
      )}
      {(run.lastSaid || run.tasks) && (
        <div className="agent-log-side">
          <Says said={run.lastSaid} lines={6} />
          <TaskChecklist tasks={run.tasks} />
        </div>
      )}
      <div className="scroll">
        <LiveLog events={events.filter(e => e !== brief)} max={300} />
      </div>
    </div>
  )
}

/** The lead, its advisor, the subagents it delegated to, and the hand-back. */
export function HiveFlow({ s }: { s: SessionDetail }) {
  const now = Date.now()
  const [openId, setOpenId] = useState<string>()
  const running = s.subagents.filter(r => r.status === 'running')
  // What the running process says beats guessing from recent writes.
  const waiting = s.waiting
  const working = s.runState ? s.runState === 'busy' : s.status === 'live'
  // Running cells first, then the most recent finished ones.
  const shown: SubagentRun[] = [...running, ...[...s.subagents].filter(r => r.status === 'done').reverse()].slice(0, MAX_CELLS)
  const hidden = s.subagents.length - shown.length
  const maxTools = Math.max(1, ...shown.map(r => r.toolCalls))
  const recentAdvice = s.advisor.slice(-3).reverse()
  const delegatedModels = [...new Set(s.subagents.map(r => shortModel(r.model)))].join(' · ')
  const cols = Math.max(1, shown.length)
  const railInset = `${100 / (2 * cols)}%`
  const leadColor = modelColor(s.mainModel)

  return (
    <div className={`flow ${working ? 'is-live' : ''} ${waiting ? 'is-waiting' : ''}`}>
      {/* Lead and advisor */}
      <div className="flow-top">
        <div className="node lead" style={{ ['--c' as string]: leadColor }}>
          <div className="node-h">
            <Hex color={leadColor} />
            <span className="node-kind">lead</span>
            <span className="node-model" style={{ color: leadColor }}>
              {shortModel(s.mainModel)}
            </span>
            <span className="grow" />
            <span className={`pill ${waiting ? 'wait' : working ? 'run' : 'idle'}`}>{waiting ? 'waiting for you' : working ? 'working' : `idle · ${ago(s.lastAt)}`}</span>
          </div>
          <WaitingBox waiting={waiting} />
          {s.lastAction && (
            <div className="node-now mono" title={s.lastAction}>
              <span className="cell-now-l">{working ? 'now' : 'last'}</span>
              {s.lastAction}
            </div>
          )}
          {/* Status, what it says and its tasks sit side by side when there's room, and stack when there isn't. */}
          <div className="lead-body">
            <div className="lead-col status">
              <EffortPips effort={s.effort} />
              <div className="node-stats">
                <span>
                  <b>{s.prompts}</b> prompts
                </span>
                <span>
                  <b>{s.toolCalls}</b> tool calls
                </span>
                <span>
                  <b>{tokens(s.contextTokens)}</b> context
                </span>
              </div>
              <ContextMeter tokens={s.contextTokens} model={s.mainModel} />
            </div>
            {s.lastSaid && (
              <div className="lead-col said">
                <Says said={s.lastSaid} lines={9} />
              </div>
            )}
            {s.tasks && (s.tasks.items.length > 0 || s.tasks.recap) && (
              <div className="lead-col todo">
                <TaskChecklist tasks={s.tasks} />
              </div>
            )}
          </div>
        </div>

        <div className={`advisor-branch ${s.advisorModel ? '' : 'off'}`}>
          <div className="branch-line" />
          <div className="node advisor" style={{ ['--c' as string]: C.opus }}>
            <div className="node-h">
              <Hex color={C.opus} filled={!!s.advisorModel} />
              <span className="node-kind">advisor</span>
              <span className="node-model" style={{ color: C.opus }}>
                {s.advisorModel ? shortModel(s.advisorModel) : 'off'}
              </span>
              <span className="grow" />
              {s.advisorCalls > 0 && <span className="count-badge">{s.advisorCalls}×</span>}
            </div>
            {recentAdvice.length > 0 ? (
              <ol className="advice-list">
                {recentAdvice.map((a, i) => (
                  <li key={`${a.at}-${i}`} title={a.about}>
                    <span className="node-foot">
                      {i === 0 ? 'last consulted' : 'consulted'} {ago(a.at)}
                      {a.who !== 'main' && ` · by ${a.who}`}
                    </span>
                    <p className="node-text">{a.about || 'no context written before the call'}</p>
                  </li>
                ))}
                {s.advisor.length > recentAdvice.length && (
                  <li className="advice-more">+{s.advisor.length - recentAdvice.length} earlier in the Advisor panel below</li>
                )}
              </ol>
            ) : (
              <p className="node-text dim">{s.advisorModel ? 'On call, not consulted yet.' : 'No advisor in this session.'}</p>
            )}
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <>
          <div className="stem short" />
          <div className="solo">Working solo: no subagents in this session yet.</div>
        </>
      ) : (
        <>
          <div className={`stem ${running.length ? 'flowing' : ''}`} />
          <div className="flow-label">
            delegated to <b>{s.subagents.length}</b> subagent{s.subagents.length === 1 ? '' : 's'}
            {delegatedModels && <span className="dim"> · {delegatedModels}</span>}
            {running.length > 0 && <span style={{ color: C.sonnet }}> · {running.length} running</span>}
          </div>
          <div className="stem short" />

          <div className="cells" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            <span className="rail top" style={{ left: railInset, right: railInset }} />
            {shown.map(r => {
              const color = modelColor(r.model)
              const live = r.status === 'running'
              return (
                <div key={r.id} className="cell-wrap">
                  <span className={`drop ${live ? 'flowing' : ''}`} />
                  <div className={`node cell ${live ? 'running' : 'done'} ${family(r.model)}`} style={{ ['--c' as string]: color }}>
                    <div className="node-h">
                      <Hex color={color} size={15} />
                      <span className="cell-name">{r.type}</span>
                      <span className="grow" />
                      <span className="node-model small" style={{ color }}>
                        {shortModel(r.model)}
                      </span>
                    </div>
                    <p className="cell-task" title={r.description}>
                      {r.description || 'no description'}
                    </p>
                    <div className="cell-now mono" title={r.lastAction}>
                      <span className="cell-now-l">{live ? 'now' : 'last'}</span>
                      {r.lastAction || (live ? 'starting…' : 'no tool calls')}
                    </div>
                    <ol className="cell-steps">
                      {/* The two steps before the one shown as "now". */}
                      {r.recent
                        .slice(0, -1)
                        .slice(-2)
                        .map((step, i) => (
                          <li key={`${step.at}-${i}`} className={step.kind}>
                            <span className="mono dim">{hms(step.at)}</span> {step.text}
                          </li>
                        ))}
                    </ol>
                    <div className="meter" title={`${r.toolCalls} tool calls`}>
                      <span style={{ width: `${(100 * r.toolCalls) / maxTools}%`, background: color }} />
                    </div>
                    <div className="cell-foot">
                      <span>{r.toolCalls} tools</span>
                      <span>·</span>
                      <span>{tokens(r.outputTokens)} out</span>
                      {r.tasks && r.tasks.items.length > 0 && (
                        <span title="Its own task list">
                          · ☑ {r.tasks.items.filter(i => i.status === 'completed').length}/{r.tasks.items.length}
                        </span>
                      )}
                      {/* Kept together, and moved to their own line when the cell is narrow. */}
                      <span className="cell-foot-end">
                        <button
                          className={`cell-log ${openId === r.id ? 'on' : ''}`}
                          onClick={() => setOpenId(openId === r.id ? undefined : r.id)}
                          aria-expanded={openId === r.id}
                        >
                          Log
                        </button>
                        <span className={`pill ${live ? 'run' : 'ok'}`}>
                          {live ? `running ${duration(now - r.startedAt)}` : `done ${duration((r.endedAt ?? now) - r.startedAt)}`}
                        </span>
                      </span>
                    </div>
                  </div>
                  <span className={`drop ${live ? '' : 'returned'}`} />
                </div>
              )
            })}
            <span className="rail bottom" style={{ left: railInset, right: railInset }} />
          </div>
          {openId && <AgentLog s={s} run={s.subagents.find(r => r.id === openId)} onClose={() => setOpenId(undefined)} />}
          {hidden > 0 && <div className="more">+{hidden} earlier subagent{hidden === 1 ? '' : 's'} in the timeline below</div>}

          <div className={`stem ${running.length ? '' : 'flowing returning'}`} />
          <div className="node back" style={{ ['--c' as string]: leadColor }}>
            <Hex color={leadColor} size={15} filled={false} />
            <span>
              back to the lead · <b style={{ color: leadColor }}>{shortModel(s.mainModel)}</b>
            </span>
            <span className="dim">
              {running.length ? `waiting on ${running.length}` : 'reviews the results'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
