// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the UI is running. The same build serves the website (a PWA in a browser) and the native app (Tauri's
 * Android WebView), and a few things differ: the native app has no service worker and no "install" prompt, and it
 * records and uploads through native code.
 */

/** True inside the Tauri app. Tauri injects `__TAURI_INTERNALS__` before any page script runs. */
export function isNativeApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** True inside the Android app, where the native recorder (and later the native uploader) exist. */
export function isAndroidApp(): boolean {
  return isNativeApp() && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
}
