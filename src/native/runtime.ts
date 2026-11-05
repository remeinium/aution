// SPDX-License-Identifier: AGPL-3.0-only
import { isNativeApp } from './platform'

/**
 * Picks an implementation once, at startup: the native one inside the Tauri app when there is one, otherwise the
 * web one. A missing native implementation falls back to the web code, which also runs in the app's WebView
 * (with the screen on), so each native part can be added on its own.
 */
export function choose<T>(impls: { web: () => T; tauri?: () => T }, native: boolean = isNativeApp()): T {
  return native && impls.tauri ? impls.tauri() : impls.web()
}
