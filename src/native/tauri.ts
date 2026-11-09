// SPDX-License-Identifier: AGPL-3.0-only
/** The native (Tauri) side of each seam. Parts that are not native yet fall back to the web code; see runtime.ts. */
import { invoke } from '@tauri-apps/api/core'
import type { Platform, SecureStore } from './types'

export const tauriPlatform: Platform = {
  kind: 'tauri',
  async openExternal(url) {
    // Loaded on demand so the website never downloads Tauri code.
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  },
}

const secret = <T>(args: Record<string, unknown>) => invoke<T>('plugin:aution-uploader|secret', args)

/** The Android Keystore (src-tauri/plugins/aution-uploader, Secrets.kt). The background uploader reads the token there too. */
export const tauriSecureStore: SecureStore = {
  separate: true,
  async get(key) { return (await secret<{ value: string | null }>({ action: 'get', name: key })).value },
  async set(key, value) { await secret({ action: 'set', name: key, value }) },
  async remove(key) { await secret({ action: 'remove', name: key }) },
}
