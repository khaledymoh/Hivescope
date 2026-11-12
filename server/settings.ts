/** Hivescope's own settings (your budgets), kept in ~/.claude/hivescope/settings.json. */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Settings } from '../shared/types.ts'

export function settingsPath(claudeDir: string): string {
  return path.join(claudeDir, 'hivescope', 'settings.json')
}

const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/** Keeps only budgets that are positive numbers. */
export function cleanSettings(value: unknown): Settings {
  const b = (typeof value === 'object' && value && (value as { budgets?: unknown }).budgets) || {}
  const budgets = b as Record<string, unknown>
  return { budgets: { fiveHour: positive(budgets.fiveHour), day: positive(budgets.day), week: positive(budgets.week) } }
}

export async function loadSettings(file: string): Promise<Settings> {
  try {
    return cleanSettings(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return { budgets: {} }
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
}
