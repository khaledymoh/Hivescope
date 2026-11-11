import { useMemo } from 'react'

import type { Overview } from '../../shared/types'
import { Chart, axis, tooltip } from './Chart'
import { AdvisorFeed, LiveLog, Panel } from './parts'
import { TalkOverview } from './Talk'
import { WaitingBox } from './HiveFlow'
import { C, type Family, WEEKDAYS, family, tokens } from './theme'

const FAMILIES: Family[] = ['opus', 'sonnet', 'haiku', 'other']

export function OverviewView({ overview, onOpen }: { overview: Overview; onOpen: (id: string) => void }) {
  const titles = useMemo(() => new Map(overview.sessions.map(s => [s.id, s.title])), [overview])

  // Output tokens per day, stacked by model family.
  const mixOption = useMemo(() => {
    const days = [...new Set(overview.daily.map(d => d.day))].sort()
    const sum = (day: string, f: Family) =>
      overview.daily.filter(d => d.day === day && family(d.model) === f).reduce((n, d) => n + d.output, 0)
    return {
      grid: { left: 48, right: 12, top: 30, bottom: 28 },
      legend: { top: 0, right: 0, textStyle: { color: C.dim }, itemWidth: 10, itemHeight: 10 },
      tooltip: { ...tooltip, trigger: 'axis' as const, valueFormatter: (v: unknown) => tokens(Number(v)) },
      xAxis: { type: 'category' as const, data: days.map(d => d.slice(5)), ...axis },
      yAxis: { type: 'value' as const, ...axis, axisLabel: { color: C.dim, formatter: (v: number) => tokens(v) } },
      series: FAMILIES.map(f => ({
        name: f,
        type: 'bar' as const,
        stack: 'out',
        barMaxWidth: 34,
        itemStyle: { color: C[f], borderRadius: f === 'other' ? [3, 3, 0, 0] : 0 },
        data: days.map(d => sum(d, f)),
      })),
    }
  }, [overview.daily])

  // Share of output by model family: is routing to cheaper models happening?
  const shareOption = useMemo(() => {
    const totals = FAMILIES.map(f => ({
      name: f,
      value: overview.daily.filter(d => family(d.model) === f).reduce((n, d) => n + d.output, 0),
      itemStyle: { color: C[f] },
    })).filter(t => t.value > 0)
    return {
      tooltip: { ...tooltip, valueFormatter: (v: unknown) => tokens(Number(v)) },
      series: [
        {
          type: 'pie' as const,
          radius: ['58%', '82%'],
          padAngle: 2,
          itemStyle: { borderRadius: 4 },
          label: { color: C.text, formatter: '{b}\n{d}%' },
          data: totals,
        },
      ],
    }
  }, [overview.daily])

  const heatOption = useMemo(() => {
    const max = Math.max(1, ...overview.heatmap.map(h => h[2]))
    return {
      grid: { left: 40, right: 12, top: 8, bottom: 46 },
      tooltip: {
        ...tooltip,
        formatter: (p: unknown) => {
          const [h, d, n] = (p as { value: [number, number, number] }).value
          return `${WEEKDAYS[d]} ${h}:00 · ${n} tool calls`
        },
      },
      xAxis: { type: 'category' as const, data: [...Array(24).keys()].map(String), ...axis, splitArea: { show: false } },
      yAxis: { type: 'category' as const, data: WEEKDAYS, ...axis, inverse: true },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: 'horizontal' as const,
        left: 'center',
        bottom: 0,
        itemHeight: 120,
        textStyle: { color: C.dim },
        inRange: { color: [C.panel2, '#5a3d0e', C.honey] },
      },
      series: [
        {
          type: 'heatmap' as const,
          data: overview.heatmap.map(([d, h, n]) => [h, d, n]),
          itemStyle: { borderColor: C.panel, borderWidth: 2, borderRadius: 3 },
        },
      ],
    }
  }, [overview.heatmap])

  const live = overview.sessions.filter(s => s.status !== 'idle')
  const waiting = overview.sessions.filter(s => s.waiting).sort((a, b) => b.waiting!.at - a.waiting!.at)

  return (
    <div className="grid">
      {waiting.length > 0 && (
        <Panel title="Waiting for you" note={`${waiting.length} session${waiting.length === 1 ? '' : 's'} · answer in that chat`} wide>
          <div className="waiting-list">
            {waiting.map(s => (
              <div key={s.id} className="waiting-item">
                <button className="link waiting-session" onClick={() => onOpen(s.id)}>
                  {s.title}
                  <span className="dim mono"> · {s.projectName}</span>
                </button>
                <WaitingBox waiting={s.waiting} />
              </div>
            ))}
          </div>
        </Panel>
      )}
      <Panel title="Active now" note={live.length ? `${live.length} in the last 30 min` : 'nothing in the last 30 min'} wide>
        {live.length === 0 ? (
          <p className="empty">No session has been active in the last 30 minutes.</p>
        ) : (
          <div className="active-row">
            {live.map(s => (
              <button key={s.id} className="active-tile" onClick={() => onOpen(s.id)}>
                <span className={`dot ${s.status}`} />
                <span className="active-title">{s.title}</span>
                <span className="active-sub" style={{ color: C[family(s.mainModel)] }}>
                  {s.lastAction || 'no tool calls yet'}
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Model mix" note="output tokens per day">
        <Chart option={mixOption} height={250} />
      </Panel>
      <Panel title="Routing check" note={`share of output, last ${overview.windowDays} days`}>
        <Chart option={shareOption} height={250} />
      </Panel>
      <Panel title="When you work" note="tool calls by weekday and hour" wide>
        <Chart option={heatOption} height={260} />
      </Panel>
      <TalkOverview overview={overview} onOpen={onOpen} />
      <Panel title="Advisor consultations" note="what Claude wrote just before asking · replies are stored encrypted">
        <div className="scroll">
          <AdvisorFeed calls={overview.advisor} onOpen={onOpen} titles={titles} />
        </div>
      </Panel>
      <Panel title="Live log" note="every session, newest first">
        <div className="scroll">
          <LiveLog events={overview.log} onOpen={onOpen} />
        </div>
      </Panel>
    </div>
  )
}
