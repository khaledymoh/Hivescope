import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useMemo } from 'react'

import { COMPACT_AT, type SessionDetail, contextWindow } from '../../shared/types'
import { Chart, axis, tooltip } from './Chart'
import { HiveFlow } from './HiveFlow'
import { ShotGallery } from './Shots'
import { TalkPanel } from './Talk'
import { AdvisorFeed, LiveLog, Panel, Stat } from './parts'
import { C, ago, duration, hms, modelColor, shortModel, tokens, usd } from './theme'

type Bar = { lane: number; from: number; to: number; color: string; opacity: number; label: string }

function rect(params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) {
  const lane = api.value(0) as number
  const start = api.coord([api.value(1), lane])
  const end = api.coord([api.value(2), lane])
  const height = (api.size?.([0, 1]) as number[])[1]! * 0.56
  const width = Math.max(2, end[0]! - start[0]!)
  const coordSys = params.coordSys as unknown as { x: number; y: number; width: number; height: number }
  return {
    type: 'rect' as const,
    shape: { x: start[0]!, y: start[1]! - height / 2, width, height, r: 3 },
    style: { fill: api.visual('color') as string, opacity: api.value(3) as number },
    clipPath: { type: 'rect' as const, shape: { x: coordSys.x, y: coordSys.y, width: coordSys.width, height: coordSys.height } },
  }
}

export function SessionView({ s }: { s: SessionDetail }) {
  const now = Date.now()
  const end = s.status === 'live' ? now : s.lastAt

  const timeline = useMemo(() => {
    const lanes = ['main session', ...s.subagents.map((r, i) => `${r.type} #${i + 1}`)]
    const bars: Bar[] = []
    const maxPerMinute = Math.max(1, ...s.activity.map(a => a[1]))
    for (const [minute, n] of s.activity) {
      bars.push({ lane: 0, from: minute, to: minute + 60_000, color: modelColor(s.mainModel), opacity: 0.3 + 0.7 * (n / maxPerMinute), label: `${n} tool calls` })
    }
    s.subagents.forEach((r, i) => {
      bars.push({
        lane: i + 1,
        from: r.startedAt,
        to: r.endedAt ?? now,
        color: modelColor(r.model),
        opacity: r.status === 'running' ? 1 : 0.75,
        label: `${r.type} · ${shortModel(r.model)} · ${r.description} · ${r.status === 'running' ? 'running' : 'done'} in ${duration((r.endedAt ?? now) - r.startedAt)}`,
      })
    })
    const laneOf = (who: string) => (who === 'main' ? 0 : Math.max(0, s.subagents.findIndex(r => r.type === who) + 1))
    const prompts = s.promptMarks.map(([at, text]) => ({ at, text }))
    return {
      grid: { left: 110, right: 18, top: 10, bottom: 54 },
      tooltip: {
        ...tooltip,
        formatter: (raw: unknown) => {
          const p = raw as { seriesName?: string; value: number[]; name?: string }
          const at = p.seriesName === 'activity' ? p.value[1] : p.value[0]
          return `${hms(at ?? 0)} · ${p.name ?? ''}`
        },
      },
      dataZoom: [
        // Only the slider zooms: wheel zoom on the chart would stop the page from scrolling over it.
        { type: 'slider' as const, xAxisIndex: 0, height: 16, bottom: 8, borderColor: C.line, fillerColor: 'rgba(245,165,36,0.15)', textStyle: { color: C.dim }, filterMode: 'weakFilter' as const },
      ],
      xAxis: { type: 'time' as const, min: s.startedAt, max: end, ...axis },
      yAxis: { type: 'category' as const, data: lanes, inverse: true, ...axis, splitLine: { show: true, lineStyle: { color: C.line } } },
      series: [
        {
          name: 'activity',
          type: 'custom' as const,
          renderItem: rect,
          encode: { x: [1, 2], y: 0 },
          data: bars.map(b => ({ value: [b.lane, b.from, b.to, b.opacity], itemStyle: { color: b.color }, name: b.label })),
        },
        {
          name: 'prompts',
          type: 'scatter' as const,
          symbol: 'triangle',
          symbolSize: 9,
          symbolOffset: [0, -14],
          itemStyle: { color: C.text },
          data: prompts.map(p => ({ value: [p.at, 0], name: p.text })),
          z: 3,
        },
        {
          name: 'advisor',
          type: 'scatter' as const,
          symbol: 'diamond',
          symbolSize: 14,
          itemStyle: { color: C.opus, borderColor: C.bg, borderWidth: 1.5 },
          data: s.advisor.map(a => ({ value: [a.at, laneOf(a.who)], name: `advisor: ${a.about.slice(0, 160)}` })),
          z: 4,
        },
      ],
    }
  }, [s, now, end])

  const toolOption = useMemo(() => {
    const top = Object.entries(s.toolMix)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reverse()
    return {
      grid: { left: 130, right: 30, top: 6, bottom: 20 },
      tooltip: { ...tooltip, trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
      xAxis: { type: 'value' as const, ...axis },
      yAxis: { type: 'category' as const, data: top.map(t => t[0].replace(/^mcp__.*__/, 'mcp:').slice(0, 22)), ...axis },
      series: [
        {
          type: 'bar' as const,
          data: top.map(t => t[1]),
          barMaxWidth: 14,
          itemStyle: { color: C.honey, borderRadius: [0, 3, 3, 0] },
          label: { show: true, position: 'right' as const, color: C.dim },
        },
      ],
    }
  }, [s.toolMix])

  // A long-running session opens on its last 24 hours of activity; the slider shows the rest.
  const sessionStart = s.startedAt
  const sessionLast = s.lastAt
  const initialZoom = useMemo(() => {
    const from = Math.max(sessionStart, sessionLast - 24 * 3_600_000)
    return from > sessionStart ? { dataZoom: [{ startValue: from }] } : undefined
    // Only when another session opens: live updates must not move the zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id])

  const models = Object.entries(s.tokensByModel).sort((a, b) => b[1].output - a[1].output)
  const running = s.subagents.filter(r => r.status === 'running')

  return (
    <div className="grid">
      <section className="panel wide session-head">
        <div className="sh-title">
          <span className={`dot ${s.status}`} />
          <h1>{s.title}</h1>
        </div>
        <p className="sh-sub mono">
          {s.cwd} · {s.entrypoint || 'unknown client'} · started {hms(s.startedAt)} · last activity {ago(s.lastAt)}
        </p>
        <div className="stats">
          <Stat label="Lead model" value={shortModel(s.mainModel)} color={modelColor(s.mainModel)} />
          <Stat label={s.advisorCost ? `Advisor · ${usd(s.advisorCost)}` : 'Advisor'} value={s.advisorModel ? `${shortModel(s.advisorModel)} · ${s.advisorCalls}×` : 'off'} color={C.opus} />
          <Stat
            label={`Context now · ${Math.round((100 * s.contextTokens) / contextWindow(s.mainModel))}%`}
            value={tokens(s.contextTokens)}
            color={s.contextTokens / contextWindow(s.mainModel) >= COMPACT_AT ? C.error : undefined}
          />
          <Stat label="Prompts" value={String(s.prompts)} />
          <Stat label="Tool calls" value={String(s.toolCalls)} />
          <Stat label="Subagents" value={`${running.length}/${s.subagentsTotal}`} color={running.length ? C.sonnet : undefined} />
          <Stat label="Errors" value={String(s.errors)} color={s.errors ? C.error : undefined} />
          <Stat label="Output tokens" value={tokens(s.outputTokens)} />
          <Stat label="Cost · API price" value={usd(s.cost)} />
        </div>
      </section>

      <Panel title="Hive flow" note="who leads, who advises, who it delegated to" wide>
        <HiveFlow s={s} />
      </Panel>

      <TalkPanel links={s.links} />

      <Panel title="Timeline" note="main activity per minute · subagent runs · ▲ prompts · ◆ advisor · drag the slider ends to zoom" wide>
        <Chart key={s.id} option={timeline} initial={initialZoom} height={Math.min(520, 120 + 34 * (s.subagents.length + 1))} />
      </Panel>

      <Panel title="Subagents" note={s.subagentsTotal ? `${s.subagentsTotal} in this session` : undefined}>
        {s.subagents.length === 0 ? (
          <p className="empty">No subagents in this session.</p>
        ) : (
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Model</th>
                  <th>Task</th>
                  <th>Status</th>
                  <th className="num">Tools</th>
                </tr>
              </thead>
              <tbody>
                {[...s.subagents].reverse().map(r => (
                  <tr key={r.id}>
                    <td style={{ color: modelColor(r.model) }}>{r.type}</td>
                    <td className="dim">{shortModel(r.model)}</td>
                    <td className="task">{r.description}</td>
                    <td style={{ color: r.status === 'running' ? C.sonnet : C.done }}>
                      {r.status} {duration((r.endedAt ?? now) - r.startedAt)}
                    </td>
                    <td className="num">{r.toolCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Tools used" note="top 10, including subagents">
        <Chart option={toolOption} height={250} />
      </Panel>

      <Panel title="Advisor" note="what Claude wrote just before asking · replies are stored encrypted">
        <div className="scroll">
          <AdvisorFeed calls={[...s.advisor].reverse()} />
        </div>
      </Panel>

      <Panel title="Tokens by model" note="this session, its subagents and advisor calls · cost at API prices">
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache write</th>
              <th className="num">Input</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {models.map(([model, b]) => (
              <tr key={model}>
                <td style={{ color: modelColor(model) }}>{shortModel(model)}</td>
                <td className="num">{tokens(b.output)}</td>
                <td className="num dim">{tokens(b.cacheRead)}</td>
                <td className="num dim">{tokens(b.cacheWrite)}</td>
                <td className="num dim">{tokens(b.input)}</td>
                <td className="num">{usd(b.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <MissedRuns s={s} />

      <Panel title="Session log" note="newest first" wide>
        <div className="scroll tall">
          <LiveLog events={s.log} max={400} />
        </div>
      </Panel>

      <ShotGallery key={s.id} sessionId={s.id} live={s.status === 'live'} />
    </div>
  )
}

/** Stretches of this session's lead work that the routing rules hand to a cheaper agent. */
function MissedRuns({ s }: { s: SessionDetail }) {
  const runs = [...s.missedRuns].reverse()
  if (runs.length === 0) return null
  const spent = runs.reduce((n, r) => n + r.cost, 0)
  const cheap = runs.reduce((n, r) => n + r.cheapCost, 0)
  return (
    <Panel title="Possible missed delegations" note={`${runs.length} · the lead spent ${usd(spent)}; the same tokens at the agents' prices: ${usd(cheap)}`} wide>
      <p className="dim small missed-why">
        From the last 7 days. A subagent would also not re-read the lead's whole context for each step, so the real saving is usually larger. Hivescope can't see why the lead did this itself: these are hints, not mistakes.
      </p>
      <div className="scroll">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Lead → suggested</th>
              <th className="num" title="Responses that made these calls; parallel calls share one">Steps</th>
              <th className="num">Lead spent</th>
              <th className="num">At agent price</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={`${r.at}-${r.kind}`}>
                <td className="mono dim">{hms(r.at)}</td>
                <td className="task" title={r.examples.join('\n')}>
                  {r.kind === 'builds' ? 'Builds and test runs' : 'Lookups'}: <span className="dim">{r.examples.join(' · ')}</span>
                </td>
                <td>
                  <span style={{ color: modelColor(r.leadModel) }}>{shortModel(r.leadModel)}</span> → <span style={{ color: modelColor(r.suggestModel) }}>{r.suggest}</span>
                </td>
                <td className="num" title={`${r.calls} tool calls`}>{r.steps}</td>
                <td className="num">{usd(r.cost)}</td>
                <td className="num dim">{usd(r.cheapCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
