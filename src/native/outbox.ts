// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The pure part of the native uploader: which notes to hand to the native outbox, and how a note's state in the
 * outbox shows in the library. No Tauri calls here, so it is tested on its own (tests/native-outbox.test.ts).
 */
import type { FlushOptions } from '../lib/uploader'
import type { Note } from '../lib/types'

/** One note in the native outbox, as the Kotlin side reports it. */
export interface NativeUpload {
  id: string
  /** The upload form's metadata as handed over (JSON text). */
  meta: string
  state: 'waiting' | 'uploading' | 'done' | 'failed'
  attempts: number
  lastError: string | null
  /** ms since epoch; 0 means as soon as there is a connection. */
  nextAttemptAt: number
  uploadedAt: number | null
}

/** What waiting uploads are held up by: no connection, or only mobile data with "Wi-Fi only" on. */
export type WaitingFor = 'network' | 'wifi' | null

/** True when this note should be handed to the native outbox now (same choice as the web uploader's flush). */
export function shouldHandOver(note: Note, inOutbox: boolean, options: FlushOptions): boolean {
  if (inOutbox) return false
  if (options.onlyId && note.id !== options.onlyId) return false
  if (note.audioRemoved) return false
  // "uploading" without an outbox entry was left behind by an earlier uploader (or the outbox was cleared).
  if (note.status === 'local' || note.status === 'uploading') return true
  return note.status === 'failed' && options.force === true
}

const waitingMessage = (waitingFor: WaitingFor) => (waitingFor === 'wifi' ? 'Waiting for Wi-Fi.' : 'Waiting for a connection.')

/** The note fields that show where its upload stands. Returns null when nothing changes. */
export function patchFromUpload(note: Note, upload: NativeUpload, waitingFor: WaitingFor, now: number): Partial<Note> | null {
  let patch: Partial<Note>
  switch (upload.state) {
    case 'done':
      patch = { status: 'uploaded', uploadedAt: upload.uploadedAt ?? now, lastError: null, nextAttemptAt: null, attempts: upload.attempts }
      break
    case 'failed':
      patch = { status: 'failed', lastError: upload.lastError, nextAttemptAt: null, attempts: upload.attempts }
      break
    case 'uploading':
      patch = { status: 'uploading', attempts: upload.attempts }
      break
    default:
      if (waitingFor) patch = { status: 'local', lastError: waitingMessage(waitingFor), nextAttemptAt: null, attempts: upload.attempts }
      else if (upload.nextAttemptAt > now) patch = { status: 'local', lastError: upload.lastError, nextAttemptAt: upload.nextAttemptAt, attempts: upload.attempts }
      // Due now: it goes as soon as the worker runs. Shown as on its way, with the last problem if there was one.
      else patch = { status: 'uploading', lastError: upload.lastError, nextAttemptAt: null, attempts: upload.attempts }
  }
  const changed = (Object.keys(patch) as (keyof Note)[]).some(key => patch[key] !== note[key])
  return changed ? patch : null
}

/** Adds a kick to the waiting ones unless the same kick is already waiting (kicks come in bursts: visible, online…). */
export function enqueueKick(queue: FlushOptions[], options: FlushOptions): FlushOptions[] {
  const key = (o: FlushOptions) => `${o.force === true}|${o.ignoreBackoff === true}|${o.onlyId ?? ''}`
  return queue.some(waiting => key(waiting) === key(options)) ? queue : [...queue, { ...options }]
}
