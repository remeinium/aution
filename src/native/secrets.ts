// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keeps the device token out of IndexedDB when the platform has a real secure store (the Android Keystore).
 * The settings object the UI sees still carries `token`, so nothing in the UI changes.
 */
import type { Settings } from '../lib/types'
import type { SecureStore } from './types'

export const TOKEN_KEY = 'device-token'

/**
 * The token to show in the settings. A token still sitting in IndexedDB (saved before the secure store existed)
 * is moved into the secure store and wiped from IndexedDB through `persistWithoutToken`.
 */
export async function readToken(stored: Settings, store: SecureStore, persistWithoutToken: (settings: Settings) => Promise<void>): Promise<string> {
  if (!store.separate) return stored.token
  const secret = await store.get(TOKEN_KEY)
  if (secret) {
    if (stored.token) await persistWithoutToken({ ...stored, token: '' })
    return secret
  }
  if (stored.token) {
    await store.set(TOKEN_KEY, stored.token)
    await persistWithoutToken({ ...stored, token: '' })
  }
  return stored.token
}

/** Saves the token where it belongs and returns the settings to write to IndexedDB. */
export async function writeToken(next: Settings, previousToken: string, store: SecureStore): Promise<Settings> {
  if (!store.separate) return next
  if (next.token !== previousToken) {
    if (next.token) await store.set(TOKEN_KEY, next.token)
    else await store.remove(TOKEN_KEY)
  }
  return { ...next, token: '' }
}
