import * as echarts from 'echarts'
import { useEffect, useRef, useState } from 'react'

import { C } from './theme'

/**
 * One ECharts instance, resized with its box, updated in place when `option` changes.
 *
 * Updates merge into the chart, so a zoom, a hover or a legend choice survives the
 * live refreshes; `initial` is applied once, when the chart is first drawn.
 *
 * Charts with axes, and graphs, can be zoomed: with the + and − buttons or Ctrl + scroll,
 * and dragged once zoomed. Every chart can fill the app's window.
 */
export function Chart({
  option,
  initial,
  height = 260,
  onClick,
}: {
  option: echarts.EChartsOption
  initial?: echarts.EChartsOption
  height?: number
  /** Called with the clicked item's `data`. */
  onClick?: (data: unknown) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts>()
  const drawn = useRef(false)
  const click = useRef(onClick)
  click.current = onClick
  const [full, setFull] = useState(false)
  const [title, setTitle] = useState('')
  const axis = zoomAxis(option)

  useEffect(() => {
    if (!box.current) return
    chart.current = echarts.init(box.current, undefined, { renderer: 'canvas' })
    chart.current.on('click', p => click.current?.(p.data))
    const observer = new ResizeObserver(() => chart.current?.resize())
    observer.observe(box.current)
    return () => {
      observer.disconnect()
      chart.current?.dispose()
    }
  }, [])

  // Esc closes the full view.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [full])

  useEffect(() => {
    if (!chart.current) return
    chart.current.setOption(
      {
        backgroundColor: 'transparent',
        textStyle: { color: C.dim, fontFamily: 'inherit' },
        animationDuration: 300,
        animationDurationUpdate: 300,
        ...option,
        dataZoom: withZoom(option, axis),
        series: withIds(option.series),
      },
      { replaceMerge: ['series'] },
    )
    if (!drawn.current && initial) chart.current.setOption(initial)
    drawn.current = true
  }, [option, initial, axis])

  /**
   * Zooms by `factor` (< 1 zooms in), keeping the point at `at` (0 to 1 across what's
   * shown) where it is: the middle for the buttons, the pointer for the wheel.
   */
  const zoom = (factor: number, at = 0.5) => {
    const c = chart.current
    if (!c) return
    if (axis === 'graph') {
      // A graph scales around its middle. ECharts' roam action doesn't redraw when called
      // from code, so the series' own zoom is set instead.
      const g = graphSeries(c)
      if (g) c.setOption({ series: [{ id: g.id, zoom: Math.min(8, Math.max(0.3, (g.zoom ?? 1) / factor)) }] })
      return
    }
    const dz = (c.getOption().dataZoom as { start?: number; end?: number }[] | undefined)?.[0]
    const start = dz?.start ?? 0
    const end = dz?.end ?? 100
    const pivot = start + (end - start) * at
    const span = Math.min(100, Math.max(2, (end - start) * factor))
    const from = Math.min(Math.max(0, pivot - span * at), 100 - span)
    c.dispatchAction({ type: 'dataZoom', start: from, end: from + span })
  }
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // The wheel zooms with Ctrl held (plain scrolling still scrolls the page), or on its own on
  // a full screen. Handled here, not by ECharts, so Ctrl + scroll never zooms the whole page.
  useEffect(() => {
    const el = box.current
    if (!el || !axis) return
    const onWheel = (e: WheelEvent) => {
      if (!full && !e.ctrlKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // Along a horizontal axis, zoom toward the pointer; categories down the side zoom from the middle.
      const at = axis === 'x' ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5
      zoomRef.current(e.deltaY < 0 ? 0.8 : 1.25, at)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [axis, full])
  const reset = () => {
    const c = chart.current
    if (!c) return
    if (axis === 'graph') {
      const g = graphSeries(c)
      // No center means the graph's own middle again.
      if (g) c.setOption({ series: [{ id: g.id, zoom: 1, center: null }] } as unknown as echarts.EChartsOption)
      return
    }
    c.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
  }

  /** Fills the app's window (not the whole screen), with the panel's heading on top. */
  const toggleFull = () => {
    if (!full) setTitle(wrap.current?.closest('.panel')?.querySelector('h2')?.textContent ?? '')
    setFull(!full)
  }

  const hint = full ? 'Scroll to zoom, drag to move' : 'Ctrl + scroll to zoom, drag to move'
  return (
    <div ref={wrap} className={`chart-wrap${full ? ' full' : ''}`}>
      {full && title && <div className="chart-title">{title}</div>}
      <div className="chart-tools" role="toolbar" aria-label="Chart">
        {axis && (
          <>
            <button type="button" title={`Zoom in · ${hint}`} aria-label="Zoom in" onClick={() => zoom(0.5)}>
              <Icon d="M8 3.5v9M3.5 8h9" />
            </button>
            <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(2)}>
              <Icon d="M3.5 8h9" />
            </button>
            <button type="button" title="Show all" aria-label="Show all" onClick={reset}>
              <Icon d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.5H6" />
            </button>
          </>
        )}
        <button type="button" title={full ? 'Close (Esc)' : 'Fill the window'} aria-label={full ? 'Close' : 'Fill the window'} onClick={toggleFull}>
          {full ? <Icon d="M4 4l8 8M12 4l-8 8" /> : <Icon d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />}
        </button>
      </div>
      <div ref={box} className="chart-box" style={{ width: '100%', height: full ? undefined : height }} />
    </div>
  )
}

/** A 16px line icon, centered in its button whatever the font. */
function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** The graph series of a chart, with its current zoom. */
function graphSeries(c: echarts.ECharts) {
  const series = (c.getOption().series ?? []) as { id?: string; type?: string; zoom?: number }[]
  return series.find(s => s.type === 'graph')
}

type ZoomAxis = { xAxisIndex: number } | { yAxisIndex: number }

/** What zooms: the category or time axis, a graph as a whole, or nothing for a pie. */
function zoomAxis(option: echarts.EChartsOption): 'x' | 'y' | 'graph' | undefined {
  const series = option.series ? (Array.isArray(option.series) ? option.series : [option.series]) : []
  if (series.some(s => s.type === 'graph')) return 'graph'
  const first = (a: unknown) => (Array.isArray(a) ? a[0] : a) as { type?: string } | undefined
  const x = first(option.xAxis)
  const y = first(option.yAxis)
  if (!x || !y) return undefined
  // A horizontal bar chart: categories run down the y axis.
  if (x.type === 'value' && y.type === 'category') return 'y'
  return 'x'
}

/** The chart's own dataZoom, plus one that pans by dragging. The wheel is handled in Chart. */
function withZoom(option: echarts.EChartsOption, axis: 'x' | 'y' | 'graph' | undefined) {
  const own = option.dataZoom ? (Array.isArray(option.dataZoom) ? option.dataZoom : [option.dataZoom]) : []
  if (!axis || axis === 'graph') return own.length ? own : undefined
  const index: ZoomAxis = axis === 'x' ? { xAxisIndex: 0 } : { yAxisIndex: 0 }
  return [
    ...own,
    { id: 'hivescope-zoom', type: 'inside' as const, ...index, zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: true, filterMode: 'weakFilter' as const },
  ]
}

/**
 * replaceMerge keeps a series only when the new option has one with the same id. Without ids,
 * every live refresh drops the series and draws it again from zero, so the bars flash.
 */
function withIds(series: echarts.EChartsOption['series']) {
  if (!series) return series
  const seen = new Set<string>()
  return (Array.isArray(series) ? series : [series]).map((s, i) => {
    let id = String(s.id ?? s.name ?? `series-${i}`)
    if (seen.has(id)) id = `${id}#${i}`
    seen.add(id)
    return { ...s, id }
  })
}

export const axis = {
  axisLine: { lineStyle: { color: C.line } },
  axisTick: { show: false },
  axisLabel: { color: C.dim },
  splitLine: { lineStyle: { color: C.line, type: 'dashed' as const } },
}

export const tooltip = {
  backgroundColor: C.panel2,
  borderColor: C.line,
  textStyle: { color: C.text },
}
