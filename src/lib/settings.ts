import { getKv, setKv } from './db'
import { currentEndpoint, normalizeEndpoint } from './endpoint'
import { secureStore } from '../native'
import { readToken, writeToken } from '../native/secrets'
import { DEFAULT_SETTINGS, type Settings } from './types'

const KEY = 'settings'

/** Version 2: the audio-removal defaults changed from "7 days / 250 MB" to "keep everything, no limit". */
export const SETTINGS_VERSION = 2

/**
 * Settings saved by an older version. Before version 2 the app removed audio by default (7 days, 250 MB), and a stored
 * value equal to that default cannot be told apart from a choice, so it moves to the safe side: keep everything.
 * Any other value is something the person picked and stays. Pure: returns what to store, and whether it changed.
 */
export function migrateSettings(stored: Partial<Settings> | undefined): { settings: Partial<Settings> | undefined; changed: boolean } {
  if (!stored || stored.settingsVersion === SETTINGS_VERSION) return { settings: stored, changed: false }
  const next: Partial<Settings> = { ...stored, settingsVersion: SETTINGS_VERSION }
  if (next.keepAfterUpload === 7) next.keepAfterUpload = DEFAULT_SETTINGS.keepAfterUpload
  if (next.storageLimitMb === 250) next.storageLimitMb = DEFAULT_SETTINGS.storageLimitMb
  return { settings: next, changed: true }
}

/** Settings from IndexedDB, with the token from the secure store where the platform has one (see src/native/secrets.ts). */
export async function loadSettings(): Promise<Settings> {
  const found = await getKv<Partial<Settings>>(KEY).catch(() => undefined)
  const { settings: stored, changed } = migrateSettings(found)
  if (changed) await setKv(KEY, stored).catch(() => undefined)
  const settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
  // A device paired before the move to aution.remeinium.com still holds the old address: follow it, once, and save it.
  const endpoint = currentEndpoint(settings.endpoint)
  if (endpoint !== settings.endpoint) { settings.endpoint = endpoint; await setKv(KEY, { ...stored, endpoint }).catch(() => undefined) }
  const token = await readToken(settings, secureStore, value => setKv(KEY, value)).catch(() => settings.token)
  return { ...settings, token }
}

/** Merges a change into the stored settings. Reading first keeps edits from different tabs from overwriting each other. */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const merged = { ...current, ...patch }
  const clean: Settings = { ...merged, endpoint: merged.endpoint ? normalizeEndpoint(merged.endpoint) || merged.endpoint.trim() : '', token: merged.token.trim() }
  await setKv(KEY, await writeToken(clean, current.token, secureStore))
  return clean
}
