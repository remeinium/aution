// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { batteryLabel, noteFromRecording, pushLevel, type NativeRecording } from '../src/native/recording'

const recording = (patch: Partial<NativeRecording> = {}): NativeRecording => ({
  id: '0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b',
  createdAt: 1_762_600_000_000,
  mime: 'audio/ogg',
  fileName: 'audio.ogg',
  state: 'done',
  durationMs: 300_400.6,
  marks: [1000, 2500.4],
  recovered: false,
  batteryStart: 82,
  batteryEnd: 79,
  ...patch,
})

describe('noteFromRecording', () => {
  it('keeps the recording id, so the upload Idempotency-Key matches', () => {
    expect(noteFromRecording(recording(), 1234).id).toBe('0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b')
  })

  it('becomes a waiting note with the real size, rounded duration and marks', () => {
    const note = noteFromRecording(recording(), 1_200_000)
    expect(note).toMatchObject({ status: 'local', size: 1_200_000, durationMs: 300_401, marks: [1000, 2500], mime: 'audio/ogg', source: 'record', createdAt: 1_762_600_000_000, attempts: 0, recovered: false })
  })

  it('keeps the battery numbers, and leaves them out when the phone did not say', () => {
    expect(noteFromRecording(recording(), 1).battery).toEqual({ start: 82, end: 79 })
    expect(noteFromRecording(recording({ batteryStart: null, batteryEnd: null }), 1).battery).toBeUndefined()
  })

  it('marks a recording rebuilt after the app was killed as recovered', () => {
    expect(noteFromRecording(recording({ recovered: true, batteryEnd: null }), 1)).toMatchObject({ recovered: true, battery: { start: 82, end: null } })
  })

  it('drops nonsense marks', () => {
    expect(noteFromRecording(recording({ marks: [-5, Number.NaN, 400] }), 1).marks).toEqual([400])
  })
})

describe('batteryLabel', () => {
  it('reads start and end', () => {
    expect(batteryLabel({ battery: { start: 82, end: 79 } })).toBe('battery 82% → 79%')
    expect(batteryLabel({ battery: { start: 82, end: null } })).toBe('battery 82% → ?')
  })
  it('is empty without numbers', () => {
    expect(batteryLabel({})).toBeNull()
    expect(batteryLabel({ battery: { start: null, end: null } })).toBeNull()
  })
})

describe('pushLevel', () => {
  it('shifts levels in, oldest first, clamped to 0..1', () => {
    const levels = new Float32Array(3)
    pushLevel(levels, 0.5)
    pushLevel(levels, 2)
    pushLevel(levels, Number.NaN)
    expect(Array.from(levels)).toEqual([0.5, 1, 0])
  })
})
