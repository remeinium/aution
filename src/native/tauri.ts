// SPDX-License-Identifier: AGPL-3.0-only
/** The native (Tauri) side of each seam. Parts that are not native yet fall back to the web code; see runtime.ts. */
import type { Platform } from './types'

export const tauriPlatform: Platform = {
  kind: 'tauri',
  async openExternal(url) {
    // Loaded on demand so the website never downloads Tauri code.
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  },
}
