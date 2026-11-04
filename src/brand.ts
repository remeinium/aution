// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The product's name and addresses, in one place. Renaming the app means changing this file and the matching
 * `productName` / `identifier` in src-tauri/tauri.conf.json (tests/brand.test.ts fails if the two disagree).
 *
 * Not branding, and deliberately NOT here: the IndexedDB name `trapper-voice` (renaming it would strand the notes
 * already on phones), the upload protocol's `app` field, and the server's own name.
 */
export const BRAND = {
  /** Shown to people: window title, top bar, home screen, notification. */
  name: 'jssayso',
  /** One line, for the page description and store listings. */
  tagline: 'Just say so. Record a voice note and it reaches your notes on its own.',
  /**
   * The Android application id (and later the iOS bundle id). PERMANENT once an APK reaches real users:
   * Android treats a different id as a different app, so changing it later breaks updates for everyone.
   */
  appId: 'com.remeinium.jss',
  /** The project's website. */
  website: 'https://jss.remeinium.com',
} as const
