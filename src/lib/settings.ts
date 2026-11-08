import { getKv, setKv } from './db'
import { currentEndpoint, normalizeEndpoint } from './endpoint'
import { secureStore } from '../native'
import { readToken, writeToken } from '../native/secrets'
import { DEFAULT_SETTINGS, type Settings } from './types'

const KEY = 'settings'

/** Settings from IndexedDB, with the token from the secure store where the platform has one (see src/native/secrets.ts). */
export async function loadSettings(): Promise<Settings> {
  const stored = await getKv<Partial<Settings>>(KEY).catch(() => undefined)
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
