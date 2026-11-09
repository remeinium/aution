// SPDX-License-Identifier: AGPL-3.0-only
/** The device seams the UI uses, chosen once at startup. See types.ts for what each one does. */
import { routeExternalLinks } from './links'
import { choose } from './runtime'
import { isAndroidApp } from './platform'
import { tauriPlatform, tauriSecureStore } from './tauri'
import type { Platform, SecureStore } from './types'
import { webPlatform, webSecureStore } from './web'

export const platform: Platform = choose({ web: () => webPlatform, tauri: () => tauriPlatform })
export const secureStore: SecureStore = choose<SecureStore>({ web: () => webSecureStore, ...(isAndroidApp() ? { tauri: () => tauriSecureStore } : {}) })

/** Call once before the UI renders. */
export function startPlatform(): void {
  if (platform.kind === 'tauri') routeExternalLinks(url => { void platform.openExternal(url) })
}
