/**
 * What Claude's tokens would cost at Anthropic's API prices, in US dollars per million tokens.
 *
 * On a Claude subscription you don't pay per token, so these are "API-equivalent" figures:
 * a way to compare models, sessions and days, not a bill.
 *
 * Prices as of 2026-11 (Anthropic's model table). Opus 5.5 was checked against the cost
 * Claude Code itself records for a session. Cache writes cost 1.25x the input price for the
 * 5-minute cache and 2x for the 1-hour cache; fast mode costs twice the standard price.
 */

export interface Price {
  input: number
  output: number
  cacheRead: number
}

/** Tokens of one model call, split the way they are priced. */
export interface Usage {
  input: number
  output: number
  cacheRead: number
  /** Written to the 5-minute cache. */
  write5m: number
  /** Written to the 1-hour cache. */
  write1h: number
}

const p = (input: number, output: number, cacheRead = input / 10): Price => ({ input, output, cacheRead })

/** Exact model versions, newest first within each family. */
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-2/, p(8, 40, 0.2)],
  [/(fable|mythos)-5-1/, p(10, 50)],
  [/(fable|mythos)-5(?!-\d)/, p(10, 50)],
  [/opus-5-5/, p(4, 20, 0.2)],
  [/opus-5(?!-\d)/, p(5, 25)],
  [/opus-4-[5-9]/, p(5, 25)],
  [/opus-4(?!-[5-9])/, p(15, 75)],
  [/sonnet-5-5/, p(2, 10, 0.1)],
  [/sonnet-5(?!-\d)/, p(2, 10, 0.2)],
  [/sonnet-4/, p(3, 15)],
  [/sonnet-3/, p(3, 15)],
  [/haiku-5-5/, p(0.1, 0.5, 0.01)],
  [/haiku-4/, p(1, 5)],
  [/haiku-3-5/, p(0.8, 4)],
]

/** A model Hivescope doesn't know: the newest price of its family. */
const FAMILY: [RegExp, Price][] = [
  [/fable|mythos/, p(8, 40, 0.2)],
  [/opus/, p(4, 20, 0.2)],
  [/sonnet/, p(2, 10, 0.1)],
  [/haiku/, p(0.1, 0.5, 0.01)],
]

/** Haiku 5.5 costs five times as much for a prompt longer than this. */
const HAIKU_LONG = 100_000

export function priceOf(model: string | undefined): { price: Price; estimated: boolean } | undefined {
  const m = (model ?? '').toLowerCase().replace(/\[.*\]$/, '')
  for (const [re, price] of PRICES) if (re.test(m)) return { price, estimated: false }
  for (const [re, price] of FAMILY) if (re.test(m)) return { price, estimated: true }
  return undefined
}

/** The API-equivalent cost of one model call, in dollars; 0 for a model with no known price. */
export function costOf(model: string | undefined, u: Usage, speed?: string): number {
  const known = priceOf(model)
  if (!known) return 0
  let { input, output, cacheRead } = known.price
  let scale = speed === 'fast' ? 2 : 1
  if (/haiku-5-5/.test(model ?? '') && u.input + u.cacheRead + u.write5m + u.write1h > HAIKU_LONG) scale *= 5
  input *= scale
  output *= scale
  cacheRead *= scale
  return (u.input * input + u.output * output + u.cacheRead * cacheRead + u.write5m * input * 1.25 + u.write1h * input * 2) / 1e6
}

/**
 * The cheapest model each delegation target runs on, for "what this would have cost there".
 * `quick` and `callsites` run on Haiku, `worker` on Sonnet, in the setup the README describes.
 */
export const AGENT_MODEL = { quick: 'claude-haiku-5-5', worker: 'claude-sonnet-5-5' } as const
