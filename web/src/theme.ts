/** Colours and formatters shared by the page and its charts. */

export const C = {
  bg: '#0e0e11',
  panel: '#16161b',
  panel2: '#1c1c22',
  line: '#2a2a33',
  text: '#e8e6e3',
  dim: '#8b8a93',
  faint: '#5a5964',
  honey: '#f5a524',
  opus: '#b48cff',
  sonnet: '#ff8a3d',
  haiku: '#5fb0ff',
  other: '#9a9aa5',
  done: '#4fd17a',
  error: '#ff5d6c',
}

export type Family = 'opus' | 'sonnet' | 'haiku' | 'other'

export function family(model: string | undefined): Family {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

export const modelColor = (model: string | undefined) => C[family(model)]

/** `claude-haiku-5-5` -> `haiku 5.5`. */
export function shortModel(model: string | undefined): string {
  const m = (model ?? '').toLowerCase().replace(/^claude-/, '').replace(/\[.*\]$/, '')
  const parts = m.match(/^(opus|sonnet|haiku|fable)[- ]?(\d+)(?:[-.](\d+))?/)
  if (parts) return parts[3] ? `${parts[1]} ${parts[2]}.${parts[3]}` : `${parts[1]} ${parts[2]}`
  return m || '—'
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** Dollars, API-equivalent: cents below $100, whole dollars above. */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** "21:00", or "Tue 21:00" when it isn't today. */
export function when(at: number, now = Date.now()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

export function hms(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
