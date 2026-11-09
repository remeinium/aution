// SPDX-License-Identifier: AGPL-3.0-only
/** Pure helpers for the native recorder (kept apart from the Tauri calls so they can be unit-tested). */
import { newNote } from '../lib/notes'
import type { Note } from '../lib/types'

/** A finished recording as the Kotlin side describes it (RecordingStore.kt, meta.json). */
export interface NativeRecording {
  id: string
  createdAt: number
  mime: string
  fileName: string
  state: 'recording' | 'paused' | 'done'
  durationMs: number
  marks: number[]
  recovered: boolean
  batteryStart: number | null
  batteryEnd: number | null
}

/** The library note for a finished native recording whose audio is `size` bytes. Same id, so uploads stay idempotent. */
export function noteFromRecording(recording: NativeRecording, size: number): Note {
  const battery = recording.batteryStart === null && recording.batteryEnd === null ? {} : { battery: { start: recording.batteryStart, end: recording.batteryEnd } }
  return newNote({
    id: recording.id,
    createdAt: recording.createdAt,
    durationMs: Math.max(0, Math.round(recording.durationMs)),
    mime: recording.mime,
    size,
    marks: recording.marks.filter(mark => Number.isFinite(mark) && mark >= 0).map(Math.round),
    recovered: recording.recovered,
    status: 'local',
    ...battery,
  })
}

/** "battery 82% → 79%" for the note's details, or null when it was not recorded. */
export function batteryLabel(note: Pick<Note, 'battery'>): string | null {
  const battery = note.battery
  if (!battery || (battery.start === null && battery.end === null)) return null
  const percent = (value: number | null) => (value === null ? '?' : `${value}%`)
  return `battery ${percent(battery.start)} → ${percent(battery.end)}`
}

/** Shifts a new level (0..1) into the waveform buffer, oldest first, as the web recorder does. */
export function pushLevel(levels: Float32Array, level: number): void {
  levels.copyWithin(0, 1)
  levels[levels.length - 1] = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
}
