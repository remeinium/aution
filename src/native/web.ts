// SPDX-License-Identifier: AGPL-3.0-only
/** The browser (PWA) side of each seam. Recorder and uploader live in src/lib and are wired there. */
import { getKv, setKv } from '../lib/db'
import type { Platform, SecureStore } from './types'

export const webPlatform: Platform = {
  kind: 'web',
  async openExternal(url) { window.open(url, '_blank', 'noopener,noreferrer') },
}

/**
 * On the web there is nothing safer than IndexedDB, so the token stays inside the settings, exactly as before
 * (`separate` is false). get/set work for other keys, kept apart from the settings.
 */
export const webSecureStore: SecureStore = {
  separate: false,
  async get(key) { return (await getKv<string>(`secret:${key}`)) ?? null },
  async set(key, value) { await setKv(`secret:${key}`, value) },
  async remove(key) { await setKv(`secret:${key}`, undefined) },
}
