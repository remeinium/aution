// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Android app's recorder: the same surface as the web VoiceRecorder, backed by the native plugin
 * (src-tauri/plugins/aution-recorder). Recording runs in a microphone foreground service, so it carries on with the
 * screen off, behind other apps and while this WebView is paused.
 *
 * When a recording finishes (here, or from the notification's Stop while the UI was asleep) its audio is copied into
 * IndexedDB as an ordinary note, and only then deleted from the native folder. Notes stay where the rest of the app
 * (library, uploader) already looks for them.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { notifyChanged } from '../lib/changes'
import { getNote, putNote, saveAudio } from '../lib/db'
import type { RecorderSnapshot } from '../lib/recorder'
import type { Note, Settings } from '../lib/types'
import { kickUploads } from '../lib/uploader'
import { noteFromRecording, pushLevel, type NativeRecording } from './recording'
import type { Recorder } from './types'

const PLUGIN = 'aution-recorder'
const call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(`plugin:${PLUGIN}|${command}`, args)
const errorText = (error: unknown) => (typeof error === 'string' ? error : error instanceof Error ? error.message : 'The recorder failed.')

interface Status { state: 'idle' | 'recording' | 'paused'; id?: string; elapsedMs?: number; marks?: number }

export class NativeRecorder implements Recorder {
  private snapshot: RecorderSnapshot = { state: 'idle', noteId: null, marks: 0, warning: null, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly levels: Float32Array
  /** Elapsed time as last reported by the service, and when; the clock runs on from there while recording. */
  private clock = { elapsedMs: 0, at: 0, running: false }
  /** Recordings being copied into IndexedDB, so "finished" events and stop() never import one twice. */
  private readonly taking = new Map<string, Promise<Note | null>>()

  constructor(bars: number) {
    this.levels = new Float32Array(bars)
    void addPluginListener<Status>(PLUGIN, 'state', status => this.apply(status))
    void addPluginListener<{ level: number }>(PLUGIN, 'level', event => pushLevel(this.levels, event.level))
    void addPluginListener<{ message: string | null }>(PLUGIN, 'warning', event => this.set({ warning: event.message }))
    void addPluginListener<{ id: string }>(PLUGIN, 'finished', () => { void this.collect() })
    void addPluginListener<{ message: string }>(PLUGIN, 'failed', event => this.set({ state: 'idle', noteId: null, error: event.message }))
    // Coming back to the app: the recording may have been paused or stopped from the notification meanwhile.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void this.refresh() })
    void this.refresh()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): RecorderSnapshot => this.snapshot

  elapsedMs(): number {
    return this.clock.elapsedMs + (this.clock.running ? performance.now() - this.clock.at : 0)
  }

  getLevels(): Float32Array { return this.levels }

  private set(patch: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private apply(status: Status) {
    if (status.state === 'idle') {
      this.clock = { elapsedMs: 0, at: performance.now(), running: false }
      // During start/stop this component moves the state itself; a stray idle event must not cut in.
      if (this.snapshot.state === 'recording' || this.snapshot.state === 'paused') this.set({ state: 'idle', noteId: null, marks: 0 })
      return
    }
    this.clock = { elapsedMs: status.elapsedMs ?? 0, at: performance.now(), running: status.state === 'recording' }
    this.set({ state: status.state, noteId: status.id ?? null, marks: status.marks ?? 0, error: null })
  }

  /** Asks the service where it is (re-attaching to a recording that ran while the UI was gone), then collects finished ones. */
  private async refresh() {
    try {
      const status = await call<Status>('status')
      if (this.snapshot.state !== 'starting' && this.snapshot.state !== 'stopping') this.apply(status)
    } catch { /* not ready yet; the next event will tell */ }
    await this.collect()
  }

  async start(settings: Settings): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    this.set({ state: 'starting', error: null, warning: null })
    try {
      const status = await call<Status>('start', { id: crypto.randomUUID(), bitrate: settings.bitrate })
      this.levels.fill(0)
      this.snapshot = { ...this.snapshot, state: 'idle' } // let apply() take it from here
      this.apply(status)
    } catch (error) {
      this.set({ state: 'idle', noteId: null, error: errorText(error) })
    }
  }

  pause(): void {
    if (this.snapshot.state !== 'recording') return
    void call<Status>('pause').then(status => this.apply(status)).catch(() => undefined)
  }

  resume(): void {
    if (this.snapshot.state !== 'paused') return
    void call<Status>('resume').then(status => this.apply(status)).catch(() => undefined)
  }

  mark(): void {
    if (this.snapshot.state !== 'recording' && this.snapshot.state !== 'paused') return
    void call<{ marks: number }>('mark').then(result => this.set({ marks: result.marks })).catch(() => undefined)
  }

  async stop(): Promise<Note | null> {
    if (this.snapshot.state !== 'recording' && this.snapshot.state !== 'paused') return null
    this.set({ state: 'stopping' })
    let recording: NativeRecording | null
    try {
      recording = (await call<{ recording: NativeRecording | null }>('stop')).recording
    } catch (error) {
      this.set({ state: 'idle', noteId: null, error: errorText(error) })
      return null
    }
    let note: Note | null = null
    let problem: string | null = null
    if (recording) {
      try { note = await this.take(recording) } catch (error) { problem = `The recording is safe on this phone but could not be added to the library yet: ${errorText(error)}` }
    }
    this.clock = { elapsedMs: 0, at: performance.now(), running: false }
    this.set({ state: 'idle', noteId: null, marks: 0, warning: problem ?? (note || recording ? null : 'Nothing was recorded.') })
    notifyChanged()
    if (note) kickUploads()
    return note
  }

  /** Brings every finished native recording into the library (for example ones stopped from the notification). */
  private async collect(): Promise<void> {
    let finished: NativeRecording[]
    try {
      finished = (await call<{ recordings: NativeRecording[] }>('finished')).recordings
    } catch {
      return
    }
    let added = 0
    for (const recording of finished) {
      try { if (await this.take(recording)) added += 1 } catch { /* stays in the native folder; tried again next time */ }
    }
    if (added) { notifyChanged(); kickUploads() }
  }

  private take(recording: NativeRecording): Promise<Note | null> {
    const running = this.taking.get(recording.id)
    if (running) return running
    const work = this.copy(recording).finally(() => this.taking.delete(recording.id))
    this.taking.set(recording.id, work)
    return work
  }

  /** Audio into IndexedDB first, the note second, the native files last: a failure at any point loses nothing. */
  private async copy(recording: NativeRecording): Promise<Note | null> {
    const existing = await getNote(recording.id)
    if (existing) {
      await call('discard', { id: recording.id })
      return existing
    }
    const bytes = await call<ArrayBuffer>('read_recording', { id: recording.id })
    if (!bytes || bytes.byteLength === 0) {
      await call('discard', { id: recording.id })
      return null
    }
    const blob = new Blob([bytes], { type: recording.mime })
    await saveAudio(recording.id, blob)
    const note = noteFromRecording(recording, blob.size)
    await putNote(note)
    // The uploader takes the file itself (a move, no copy through the page); without it the copy in IndexedDB is used.
    await invoke('plugin:aution-uploader|adopt', { id: recording.id }).catch(() => undefined)
    await call('discard', { id: recording.id })
    return note
  }
}
