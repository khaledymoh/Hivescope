import * as echarts from 'echarts'
import { useEffect, useRef } from 'react'

import { C } from './theme'

/**
 * One ECharts instance, resized with its box, updated in place when `option` changes.
 *
 * Updates merge into the chart, so a zoom, a hover or a legend choice survives the
 * live refreshes; `initial` is applied once, when the chart is first drawn.
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
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts>()
  const drawn = useRef(false)
  const click = useRef(onClick)
  click.current = onClick

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

  useEffect(() => {
    if (!chart.current) return
    chart.current.setOption(
      {
        backgroundColor: 'transparent',
        textStyle: { color: C.dim, fontFamily: 'inherit' },
        animationDuration: 300,
        animationDurationUpdate: 300,
        ...option,
        series: withIds(option.series),
      },
      { replaceMerge: ['series'] },
    )
    if (!drawn.current && initial) chart.current.setOption(initial)
    drawn.current = true
  }, [option, initial])

  return <div ref={box} style={{ width: '100%', height }} />
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
