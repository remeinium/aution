// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Android app's uploader: hands waiting notes to the native outbox (src-tauri/plugins/aution-uploader), where a
 * WorkManager worker sends them with retries, also with the app closed and after a reboot. The library still reads
 * IndexedDB; the outbox's state is copied back into the notes whenever the app is open (`reconcile`).
 *
 * The audio in IndexedDB is only removed after the outbox reports "done", i.e. after the server confirmed it, and
 * then only as the "Keep audio after upload" setting says.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { notifyChanged } from '../lib/changes'
import { getAudio, getNote, listNotes, onNoteDeleted, removeAudio, updateNote } from '../lib/db'
import { isSignedIn, normalizeEndpoint } from '../lib/endpoint'
import { extensionFor } from '../lib/mime'
import { loadSettings } from '../lib/settings'
import type { FlushOptions } from '../lib/uploader'
import type { Note, Settings } from '../lib/types'
import { flushEdits, uploadMeta } from '../lib/uploader'
import { enqueueKick, patchFromUpload, shouldHandOver, type NativeUpload, type WaitingFor } from './outbox'
import type { Uploader } from './types'

const PLUGIN = 'aution-uploader'
const call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(`plugin:${PLUGIN}|${command}`, args)

interface Outbox { queued: Map<string, NativeUpload>; staged: Set<string> }

/** Copies the outbox's state into the notes, removes uploaded audio as the settings say, and clears finished entries. */
export async function reconcile(): Promise<Outbox> {
  const { uploads, staged, waitingFor } = await call<{ uploads: NativeUpload[]; staged: string[]; waitingFor: WaitingFor }>('uploads')
  const settings = await loadSettings()
  const now = Date.now()
  let changed = false
  for (const upload of uploads) {
    const note = await getNote(upload.id)
    if (!note) { await call('forget', { id: upload.id }); continue } // removed from this device meanwhile
    // Signed out: the worker cannot send anything (it has no token), so a queued note waits for a sign-in.
    const patch = patchFromUpload(note, upload, isSignedIn(settings) ? waitingFor : 'signin', now)
    if (patch) { await updateNote(upload.id, patch); changed = true }
    if (upload.state === 'done') {
      if (settings.keepAfterUpload === 0 && !note.audioRemoved) {
        await removeAudio(upload.id)
        await updateNote(upload.id, { audioRemoved: true })
        changed = true
      }
      await call('forget', { id: upload.id })
    }
  }
  for (const id of staged) if (!(await getNote(id))) await call('forget', { id }) // audio of a note removed meanwhile
  if (changed) notifyChanged()
  return { queued: new Map(uploads.filter(upload => upload.state !== 'done').map(upload => [upload.id, upload])), staged: new Set(staged) }
}

/** Base64 pieces of this many bytes: Tauri's IPC from the page is JSON text on Android, so raw bytes cannot go in one call. */
const PIECE = 256 * 1024

async function stageAudio(id: string, blob: Blob): Promise<void> {
  for (let offset = 0; offset < blob.size; offset += PIECE) {
    const piece = new Uint8Array(await blob.slice(offset, offset + PIECE).arrayBuffer())
    await call('stage', { id, offset, data: toBase64(piece), last: offset + PIECE >= blob.size })
  }
}

export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** Puts the note's audio into the outbox (unless it is there already) and adds it to the queue with its upload metadata. */
async function handOver(id: string, staged: boolean): Promise<void> {
  const note = await getNote(id)
  if (!note) return
  const blob = await getAudio(id)
  if (!blob) {
    await updateNote(id, { status: 'failed', lastError: 'The audio file is missing from this device.', nextAttemptAt: null })
    return
  }
  const settings = await loadSettings()
  if (!staged) await stageAudio(id, blob)
  await refreshMeta(note, settings)
  await updateNote(id, { status: 'uploading', lastError: null, nextAttemptAt: null })
}

async function refreshMeta(note: Note, settings: Settings) {
  await call('enqueue', { id: note.id, meta: JSON.stringify(uploadMeta(note, settings)), mime: note.mime, fileName: `${note.id}.${extensionFor(note.mime)}` })
}

async function pass(options: FlushOptions): Promise<void> {
  const settings = await loadSettings()
  const endpoint = normalizeEndpoint(settings.endpoint)
  const { queued, staged } = await reconcile()
  if (!endpoint || !isSignedIn(settings)) return // nothing can go before a sign-in; signing in kicks the uploads again
  if (settings.autoUpload || options.force) {
    for (const note of await listNotes()) {
      const entry = queued.get(note.id)
      if (shouldHandOver(note, entry !== undefined, options)) {
        try { await handOver(note.id, staged.has(note.id)) } catch { /* stays waiting in the library; tried again on the next pass */ }
      } else if (entry && (entry.state === 'waiting' || entry.state === 'failed')) {
        // A rename or tag change made before the upload goes along with it.
        try { await refreshMeta(note, settings) } catch { /* the older metadata still uploads */ }
      }
    }
  }
  await call('schedule', { endpoint, wifiOnly: settings.wifiOnly, force: options.force === true, ignoreBackoff: options.ignoreBackoff === true, onlyId: options.onlyId ?? null })
  await reconcile()
  await flushEdits()
}

export class NativeUploader implements Uploader {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  /** Kicks not run yet, in order; identical ones are kept once. */
  private queue: FlushOptions[] = []

  constructor() {
    // The worker reports every change; copy it into the library while the app is open.
    void addPluginListener(PLUGIN, 'changed', () => { void reconcile().catch(() => undefined) })
    // A note removed from this device must not be sent afterwards.
    onNoteDeleted(id => { void call('forget', { id }).catch(() => undefined) })
  }

  /** Debounced; a kick while a pass runs is run after it. Safe to call often. */
  kick(options: FlushOptions = {}): void {
    this.queue = enqueueKick(this.queue, options)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.drain() }, 250)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) await pass(next).catch(() => undefined)
    } finally {
      this.running = false
    }
  }
}
