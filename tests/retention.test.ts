import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../src/lib/types'
import { DEFAULT_SETTINGS } from '../src/lib/types'

// An in-memory stand-in for IndexedDB, so the executor can be tested without a browser.
const store = vi.hoisted(() => ({ notes: new Map<string, unknown>(), kv: new Map<string, unknown>(), audio: new Set<string>(), removed: [] as string[], afterList: null as (() => void) | null }))
vi.mock('../src/lib/db', () => ({
  getKv: async (key: string) => store.kv.get(key),
  setKv: async (key: string, value: unknown) => { store.kv.set(key, value) },
  getNote: async (id: string) => store.notes.get(id),
  listNotes: async () => { const snapshot = [...store.notes.values()]; store.afterList?.(); return snapshot },
  updateNote: async (id: string, patch: object) => { store.notes.set(id, { ...(store.notes.get(id) as object), ...patch }) },
  removeAudio: async (id: string) => { store.audio.delete(id); store.removed.push(id) },
}))
vi.mock('../src/lib/changes', () => ({ notifyChanged: () => undefined }))
vi.mock('../src/native', () => ({ secureStore: null }))

import { KEEP_NEWEST, applyRetention, freeNow, getRetentionLog, isSafeToRemove, planFreeNow, planRetention, summarize, type RetentionPolicy } from '../src/lib/retention'
import { migrateSettings } from '../src/lib/settings'
import { newNote } from '../src/lib/notes'

const MB = 1024 * 1024
const DAY = 86_400_000
const NOW = 1_000 * DAY
const off: RetentionPolicy = { keepAfterUploadDays: -1, limitMb: 0, keepNewest: KEEP_NEWEST }
/** Ten uploaded notes of 100 MB, `n1` the oldest, each uploaded the day it was recorded. */
const notes = (count = 10, extra: (index: number) => Partial<Note> = () => ({})): Note[] =>
  Array.from({ length: count }, (_, index) => newNote({ id: `n${index + 1}`, createdAt: NOW - (count - index) * DAY, uploadedAt: NOW - (count - index) * DAY, size: 100 * MB, status: 'uploaded', ...extra(index) }))
const ids = (plan: Array<{ id: string }>) => plan.map(item => item.id)

describe('the default policy removes nothing', () => {
  it('keeps everything when both rules are off, however old or large', () => {
    expect(planRetention(notes(10), off, NOW)).toEqual([])
    expect(planRetention(notes(10), { ...off, keepAfterUploadDays: Number.NaN, limitMb: Number.NaN }, NOW)).toEqual([])
  })
  it('new installs start with both rules off', () => {
    expect(DEFAULT_SETTINGS.keepAfterUpload).toBe(-1)
    expect(DEFAULT_SETTINGS.storageLimitMb).toBe(0)
  })
})

describe('the invariant: only audio the server has', () => {
  const unsafe: Array<Partial<Note>> = [{ status: 'local' }, { status: 'failed' }, { status: 'uploading' }, { status: 'recording' }, { audioRemoved: true }, { uploadedAt: null }]
  for (const patch of unsafe) {
    it(`never removes a note that is ${JSON.stringify(patch)}`, () => {
      const list = notes(1, () => patch)
      expect(isSafeToRemove(list[0] as Note)).toBe(false)
      expect(planRetention(list, { keepAfterUploadDays: 0, limitMb: 1, keepNewest: 0 }, NOW)).toEqual([])
      expect(planFreeNow(list)).toEqual([])
    })
  }
})

describe('keep audio after upload (the age rule)', () => {
  it('0 removes every uploaded note right away', () => {
    const plan = planRetention(notes(3), { ...off, keepAfterUploadDays: 0 }, NOW)
    expect(ids(plan)).toEqual(['n1', 'n2', 'n3'])
    expect(plan.every(item => item.reason === 'after-upload')).toBe(true)
  })
  it('N days removes only notes uploaded at least N days ago', () => {
    // n1 uploaded 10 days ago ... n10 uploaded 1 day ago
    expect(ids(planRetention(notes(10), { ...off, keepAfterUploadDays: 7 }, NOW))).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(ids(planRetention(notes(10), { ...off, keepAfterUploadDays: 1 }, NOW))).toEqual(ids(notes(10)))
    expect(planRetention(notes(10), { ...off, keepAfterUploadDays: 30 }, NOW)).toEqual([])
  })
})

describe('the size limit', () => {
  const limit = (count: number, mb: number, extra?: (index: number) => Partial<Note>) => ids(planRetention(notes(count, extra), { ...off, limitMb: mb }, NOW))
  it('does nothing while under the limit', () => { expect(limit(2, 250)).toEqual([]) })
  it('removes the oldest first, and stops as soon as the rest fits', () => {
    expect(limit(10, 600)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(limit(10, 800)).toEqual(['n1', 'n2'])
  })
  it('never touches the newest five, even when that leaves the device over its limit', () => {
    expect(limit(10, 250)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(limit(6, 100)).toEqual(['n1'])
    expect(limit(KEEP_NEWEST, 1)).toEqual([])
  })
  it('skips notes that are not on the server', () => {
    expect(limit(10, 250, index => (index === 0 ? { status: 'local' } : index === 1 ? { status: 'failed' } : index === 2 ? { status: 'uploading' } : {}))).toEqual(['n4', 'n5'])
  })
  it('ignores audio already gone and a recording in progress', () => {
    const list = [...notes(10, index => (index < 3 ? { audioRemoved: true } : {})), newNote({ id: 'live', createdAt: NOW, size: 900 * MB, status: 'recording' })]
    expect(ids(planRetention(list, { ...off, limitMb: 600 }, NOW))).toEqual(['n4'])
    expect(ids(planRetention(list, { ...off, limitMb: 500 }, NOW))).toEqual(['n4', 'n5'])
  })
  it('protects the newest by when they were recorded, not by list order', () => {
    expect(ids(planRetention([...notes()].reverse(), { ...off, limitMb: 250 }, NOW))).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
  })
  it('counts audio the age rule already removed, so the two rules do not remove more than needed', () => {
    // 7 days removes n1..n4 (400 MB); 600 MB remain, which fits a 600 MB limit, so the size rule adds nothing.
    const plan = planRetention(notes(10), { keepAfterUploadDays: 7, limitMb: 600, keepNewest: KEEP_NEWEST }, NOW)
    expect(ids(plan)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(plan.map(item => item.reason)).toEqual(['age', 'age', 'age', 'age'])
  })
})

describe('free up space now', () => {
  it('lists every note that is safe on the server, oldest first, and sums it for the preview', () => {
    const plan = planFreeNow(notes(4, index => (index === 3 ? { status: 'local' } : {})))
    expect(ids(plan)).toEqual(['n1', 'n2', 'n3'])
    expect(summarize(plan)).toEqual({ count: 3, bytes: 300 * MB })
  })
})

describe('settings migration', () => {
  it('moves the old defaults (7 days, 250 MB) to "keep everything"', () => {
    const { settings, changed } = migrateSettings({ endpoint: 'https://x', keepAfterUpload: 7, storageLimitMb: 250 })
    expect(changed).toBe(true)
    expect(settings).toMatchObject({ endpoint: 'https://x', keepAfterUpload: -1, storageLimitMb: 0, settingsVersion: 2 })
  })
  it('keeps a value the person picked', () => {
    expect(migrateSettings({ keepAfterUpload: 1, storageLimitMb: 500 }).settings).toMatchObject({ keepAfterUpload: 1, storageLimitMb: 500, settingsVersion: 2 })
    expect(migrateSettings({ keepAfterUpload: 0 }).settings?.keepAfterUpload).toBe(0)
  })
  it('does nothing twice, and nothing on a fresh install', () => {
    expect(migrateSettings({ keepAfterUpload: 7, settingsVersion: 2 }).changed).toBe(false)
    expect(migrateSettings(undefined)).toEqual({ settings: undefined, changed: false })
  })
})

describe('applying the rules', () => {
  beforeEach(() => {
    store.notes.clear(); store.kv.clear(); store.audio.clear(); store.removed.length = 0; store.afterList = null
    store.kv.set('settings', { settingsVersion: 2, keepAfterUpload: 0 })
    for (const note of notes(3)) { store.notes.set(note.id, note); store.audio.add(note.id) }
  })

  it('removes audio, marks the note, keeps the note, and writes one log entry', async () => {
    expect(await applyRetention()).toBe(3)
    expect(store.removed.sort()).toEqual(['n1', 'n2', 'n3'])
    expect((store.notes.get('n1') as Note).audioRemoved).toBe(true)
    const log = await getRetentionLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ count: 3, bytes: 300 * MB, reasons: ['after-upload'] })
  })

  it('removes nothing, and logs nothing, with the default settings', async () => {
    store.kv.set('settings', { settingsVersion: 2 })
    expect(await applyRetention()).toBe(0)
    expect(store.removed).toEqual([])
    expect(await getRetentionLog()).toEqual([])
  })

  it('checks the invariant again at removal time (a note that changed after planning is left alone)', async () => {
    // The plan is made from a snapshot; n2 is retried (status back to local) right after it, before the removal.
    store.afterList = () => { store.afterList = null; store.notes.set('n2', { ...(store.notes.get('n2') as Note), status: 'local' }) }
    expect(await applyRetention()).toBe(2)
    expect(store.removed.sort()).toEqual(['n1', 'n3'])
  })

  it('overlapping calls coalesce: no double removal, and a late arrival is still handled', async () => {
    const [a, b] = await Promise.all([applyRetention(), applyRetention()])
    expect(a).toBeGreaterThanOrEqual(0)
    expect(b).toBeGreaterThanOrEqual(0)
    expect(store.removed.sort()).toEqual(['n1', 'n2', 'n3'])
  })

  it('"free up space now" frees all safe audio whatever the rules say', async () => {
    store.kv.set('settings', { settingsVersion: 2 })
    expect(await freeNow()).toEqual({ count: 3, bytes: 300 * MB })
    expect((await getRetentionLog())[0]?.reasons).toEqual(['manual'])
  })

  it('keeps only the last 20 runs in the log', async () => {
    store.kv.set('retention-log', Array.from({ length: 25 }, (_, at) => ({ at, count: 1, bytes: 1, reasons: ['age'] })))
    await applyRetention()
    expect(await getRetentionLog()).toHaveLength(20)
  })
})
