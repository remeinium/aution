// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The seams between the UI and the device. The UI only ever talks to these interfaces; each has a web
 * implementation (today's PWA code) and a native one used inside the Tauri app. Keep them small: anything
 * that is the same on both sides stays in src/lib.
 */
import type { RecorderSnapshot } from '../lib/recorder'
import type { FlushOptions } from '../lib/uploader'
import type { Note, Settings } from '../lib/types'

/** Records one note at a time. Same surface as the web VoiceRecorder, which the UI already uses. */
export interface Recorder {
  subscribe(listener: () => void): () => void
  getSnapshot(): RecorderSnapshot
  /** Recorded time in ms, excluding pauses. */
  elapsedMs(): number
  /** The most recent input levels (0..1), oldest first, for the waveform. */
  getLevels(): Float32Array
  start(settings: Settings): Promise<void>
  pause(): void
  resume(): void
  mark(): void
  /** Stops and saves. Resolves with the saved note, or null when nothing was captured. */
  stop(): Promise<Note | null>
}

/** Sends waiting notes to the server. */
export interface Uploader {
  /** Starts an upload pass soon and keeps retrying with backoff. Safe to call often. */
  kick(options?: FlushOptions): void
}

/** Small secrets (the device token). On the web this is IndexedDB, as before; natively the Android Keystore. */
export interface SecureStore {
  /**
   * True when secrets live apart from the settings in IndexedDB. Then the settings keep an empty token and
   * the real one is read from here.
   */
  readonly separate: boolean
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface Platform {
  readonly kind: 'web' | 'tauri'
  /** Opens a web page outside the app: a new tab on the web, the system browser in the native app. */
  openExternal(url: string): Promise<void>
}
