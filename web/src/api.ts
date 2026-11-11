import { useEffect, useRef, useState } from 'react'

import type { Overview, SessionDetail } from '../../shared/types'

/** The server's update counter, pushed live; every change refetches what the page shows. */
export function useVersion(): { version: number; connected: boolean } {
  const [version, setVersion] = useState(0)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const source = new EventSource('/api/stream')
    source.addEventListener('update', () => setVersion(v => v + 1))
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    return () => source.close()
  }, [])
  return { version, connected }
}

/** Fetch JSON whenever `version` or `url` changes, at most once a second, keeping the last good value. */
export function useLive<T>(url: string | undefined, version: number): T | undefined {
  const [data, setData] = useState<T>()
  const last = useRef(0)
  const timer = useRef<number>()
  useEffect(() => {
    if (!url) {
      setData(undefined)
      return
    }
    let cancelled = false
    const run = async () => {
      last.current = Date.now()
      try {
        const res = await fetch(url)
        if (res.ok && !cancelled) setData((await res.json()) as T)
      } catch {
        // Keep the last value; the connection banner says the server is away.
      }
    }
    const wait = Math.max(0, 1000 - (Date.now() - last.current))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(run, wait)
    return () => {
      cancelled = true
    }
  }, [url, version])
  useEffect(() => setData(undefined), [url])
  return data
}

export type { Overview, SessionDetail }
