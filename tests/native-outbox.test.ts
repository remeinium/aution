// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { newNote } from '../src/lib/notes'
import { statusMessage } from '../src/lib/rules'
import type { Note } from '../src/lib/types'
import { enqueueKick, patchFromUpload, shouldHandOver, type NativeUpload } from '../src/native/outbox'

const NOW = 1_762_600_000_000
const note = (patch: Partial<Note> = {}) => newNote({ id: '0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b', mime: 'audio/ogg', ...patch })
const upload = (patch: Partial<NativeUpload> = {}): NativeUpload => ({
  id: '0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b', meta: '{}', state: 'waiting', attempts: 0, lastError: null, nextAttemptAt: 0, uploadedAt: null, ...patch,
})

describe('shouldHandOver', () => {
  it('hands over waiting notes, and notes left "uploading" with no outbox entry', () => {
    expect(shouldHandOver(note({ status: 'local' }), false, {})).toBe(true)
    expect(shouldHandOver(note({ status: 'uploading' }), false, {})).toBe(true)
  })
  it('never twice, never uploaded or audio-less notes', () => {
    expect(shouldHandOver(note({ status: 'local' }), true, {})).toBe(false)
    expect(shouldHandOver(note({ status: 'uploaded' }), false, { force: true })).toBe(false)
    expect(shouldHandOver(note({ status: 'local', audioRemoved: true }), false, {})).toBe(false)
  })
  it('retries refused notes only when forced, and only the one asked for', () => {
    expect(shouldHandOver(note({ status: 'failed' }), false, {})).toBe(false)
    expect(shouldHandOver(note({ status: 'failed' }), false, { force: true })).toBe(true)
    expect(shouldHandOver(note({ status: 'failed' }), false, { force: true, onlyId: 'another' })).toBe(false)
  })
})

describe('patchFromUpload', () => {
  it('marks a confirmed upload as uploaded', () => {
    expect(patchFromUpload(note({ status: 'uploading' }), upload({ state: 'done', attempts: 1, uploadedAt: NOW - 5 }), null, NOW))
      .toEqual({ status: 'uploaded', uploadedAt: NOW - 5, lastError: null, nextAttemptAt: null, attempts: 1 })
  })
  it('shows a refusal as failed with its reason', () => {
    expect(patchFromUpload(note(), upload({ state: 'failed', attempts: 1, lastError: statusMessage(401) }), null, NOW))
      .toMatchObject({ status: 'failed', lastError: 'The server rejected the access token.' })
  })
  it('shows a note in backoff as waiting, with when it tries again', () => {
    expect(patchFromUpload(note(), upload({ attempts: 2, lastError: 'No connection to the server.', nextAttemptAt: NOW + 10_000 }), null, NOW))
      .toEqual({ status: 'local', lastError: 'No connection to the server.', nextAttemptAt: NOW + 10_000, attempts: 2 })
  })
  it('says what it is waiting for when there is no usable network', () => {
    expect(patchFromUpload(note(), upload(), 'wifi', NOW)).toMatchObject({ status: 'local', lastError: 'Waiting for Wi-Fi.' })
    expect(patchFromUpload(note(), upload(), 'network', NOW)).toMatchObject({ status: 'local', lastError: 'Waiting for a connection.' })
  })
  it('shows a due note as on its way', () => {
    expect(patchFromUpload(note(), upload(), null, NOW)).toMatchObject({ status: 'uploading' })
  })
  it('returns null when nothing changes, so the library does not redraw for nothing', () => {
    const current = note({ status: 'uploading', attempts: 1 })
    expect(patchFromUpload(current, upload({ state: 'uploading', attempts: 1 }), null, NOW)).toBeNull()
  })
})

describe('enqueueKick', () => {
  it('keeps one of each kick, in order, and never merges a one-note retry into a retry of everything', () => {
    let queue = enqueueKick([], { ignoreBackoff: true })
    queue = enqueueKick(queue, { ignoreBackoff: true })
    queue = enqueueKick(queue, { force: true, ignoreBackoff: true, onlyId: 'a' })
    queue = enqueueKick(queue, {})
    expect(queue).toEqual([{ ignoreBackoff: true }, { force: true, ignoreBackoff: true, onlyId: 'a' }, {}])
  })
})

describe('Kotlin upload rules match src/lib/rules.ts', () => {
  const kotlin = readFileSync('src-tauri/plugins/aution-uploader/android/src/main/java/com/remeinium/aution/uploader/Rules.kt', 'utf8')
  it('uses the same messages', () => {
    for (const status of [401, 404, 413, 415, 429]) expect(kotlin).toContain(`"${statusMessage(status)}"`)
    expect(kotlin).toContain('"The server had a problem ($status)."')
    expect(kotlin).toContain('"The server answered $status."')
  })
  it('uses the same numbers', () => {
    for (const piece of ['status == 409', 'status == 408 || status == 425 || status == 429 || status >= 500', '15 * 60_000', '5_000.0', '0.8 + random * 0.4', '3600', '50_000']) {
      expect(kotlin).toContain(piece)
    }
  })
})

describe('toBase64 (audio pieces for the outbox)', () => {
  it('encodes bytes exactly, also past the 32 KB batching step', async () => {
    const { toBase64 } = await import('../src/native/tauri-uploader')
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256)
    expect(Buffer.from(toBase64(bytes), 'base64').equals(Buffer.from(bytes))).toBe(true)
    expect(toBase64(new Uint8Array())).toBe('')
  })
})
