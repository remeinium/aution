import { appendFile, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DriveStorage, type DriveStorageOptions } from '../src/storage-drive.ts'
import type { StoragePolicy } from '../src/storage.ts'
import { FakeDrive, FakeTokens } from './fake-drive.ts'
import { tempDir } from './helpers.ts'

const A = '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b'
const B = '44444444-4444-4444-8444-444444444444'
const C = '55555555-5555-4555-8555-555555555555'
const encode = (text: string) => new TextEncoder().encode(text)
const meta = (id: string) => encode(JSON.stringify({ id }))
const pattern = (size: number, seed = 0) => Uint8Array.from({ length: size }, (_, index) => (index * 7 + seed) % 251)
const HOUR = 60 * 60_000

const open: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of open.splice(0).reverse()) await close() })

/** A Drive-backed storage whose per-person policy the test can change at any moment. */
async function rig(initial: Partial<StoragePolicy> = {}, extra: Partial<DriveStorageOptions> = {}) {
  const fake = await new FakeDrive().start()
  const dir = await tempDir()
  open.push(async () => { await fake.close(); await dir.clean() })
  const policies = new Map<string, StoragePolicy>()
  const base: StoragePolicy = { retainAudio: 'keep', maxCacheBytes: 0, trashOnDelete: false, ...initial }
  const policy = (user: string) => policies.get(user) ?? base
  const storage = new DriveStorage({ tokens: new FakeTokens(), cacheDir: dir.dir, apiBase: fake.apiBase, uploadBase: fake.uploadBase, chunkBytes: 262_144, random: () => 1, sleep: async () => undefined, retry: { baseMs: 1, maxMs: 2 }, policy, ...extra })
  const age = (user: string, note: string, name: string, ms: number) => { const at = new Date(Date.now() - ms); return utimes(join(dir.dir, user, note, name), at, at) }
  const cached = async (user: string, note: string) => (await readdir(join(dir.dir, user, note)).catch(() => [] as string[])).sort()
  return { fake, storage, dir: dir.dir, policies, base, age, cached }
}

describe('the audio cache stays under the size the person chose', () => {
  it('does nothing without a cap, and a cap of 0 means no limit', async () => {
    const { storage, age, cached } = await rig()
    for (const [index, note] of [A, B].entries()) { await storage.createNote('alice', note, { meta: meta(note), files: { 'audio.webm': pattern(300_000, index) } }); await age('alice', note, 'audio.webm', 48 * HOUR) }
    expect(await storage.trimCache('alice')).toEqual({ freedFiles: 0, freedBytes: 0, skipped: 0 })
    expect(await cached('alice', A)).toEqual(['audio.webm'])
    expect(await storage.cacheUsage('alice')).toEqual({ bytes: 600_000, files: 2 })
  })

  it('frees the oldest first and stops as soon as it fits; Drive keeps every recording', async () => {
    const { fake, storage, policies, base, age, cached } = await rig()
    for (const [index, note] of [A, B, C].entries()) { await storage.createNote('alice', note, { meta: meta(note), files: { 'audio.webm': pattern(300_000, index) } }) }
    await age('alice', A, 'audio.webm', 72 * HOUR)
    await age('alice', B, 'audio.webm', 48 * HOUR)
    await age('alice', C, 'audio.webm', 24 * HOUR)
    policies.set('alice', { ...base, maxCacheBytes: 700_000 }) // 900 kB held: dropping the oldest is enough
    expect(await storage.trimCache('alice')).toEqual({ freedFiles: 1, freedBytes: 300_000, skipped: 0 })
    expect(await cached('alice', A)).toEqual([])
    expect(await cached('alice', B)).toEqual(['audio.webm'])
    expect(await cached('alice', C)).toEqual(['audio.webm'])
    expect(fake.files('alice').filter(file => file.name === 'audio.webm')).toHaveLength(3)
    policies.set('alice', { ...base, maxCacheBytes: 1 })
    expect((await storage.trimCache('alice')).freedFiles).toBe(2)
    expect(await storage.cacheUsage('alice')).toEqual({ bytes: 0, files: 0 })
  })

  it('serves an evicted recording again by fetching it back from Drive', async () => {
    const { storage, policies, base, age } = await rig()
    const audio = pattern(300_000)
    await storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': audio } })
    await age('alice', A, 'audio.webm', 48 * HOUR)
    policies.set('alice', { ...base, maxCacheBytes: 1 })
    await storage.trimCache('alice')
    expect(Buffer.compare((await storage.get('alice', A, 'audio.webm'))!, audio)).toBe(0)
  })

  it('never touches state.json, a fresh temp file, or a recording stored in the last hour', async () => {
    const { storage, dir, policies, base, age, cached } = await rig()
    await storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(300_000) } })
    await storage.put('alice', A, 'state.json', encode('{"attempts":2}'))
    await storage.createNote('alice', B, { meta: meta(B), files: { 'audio.webm': pattern(300_000, 1) } })
    await age('alice', A, 'audio.webm', 48 * HOUR) // old enough; B is brand new
    await writeFile(join(dir, 'alice', A, 'audio.webm.abcd1234.tmp'), 'half written')
    policies.set('alice', { ...base, maxCacheBytes: 1 })
    expect(await storage.trimCache('alice')).toEqual({ freedFiles: 1, freedBytes: 300_000, skipped: 1 })
    expect(await cached('alice', A)).toEqual(['audio.webm.abcd1234.tmp', 'state.json'])
    expect(await cached('alice', B)).toEqual(['audio.webm'])
    expect(new TextDecoder().decode((await storage.get('alice', A, 'state.json'))!)).toBe('{"attempts":2}')
  })

  it('sweeps temp files left by a crash, but only once they are a day old, and even with no cap', async () => {
    const { storage, dir, age, cached } = await rig()
    await storage.createNote('alice', A, { meta: meta(A) })
    await mkdir(join(dir, 'alice', A), { recursive: true })
    await writeFile(join(dir, 'alice', A, 'audio.webm.aaaa1111.tmp'), 'old')
    await writeFile(join(dir, 'alice', A, 'audio.webm.bbbb2222.tmp'), 'new')
    await age('alice', A, 'audio.webm.aaaa1111.tmp', 25 * HOUR)
    await storage.trimCache('alice')
    expect(await cached('alice', A)).toEqual(['audio.webm.bbbb2222.tmp'])
  })

  it('applies each person’s own cap, not anyone else’s', async () => {
    const { storage, policies, base, age, cached } = await rig()
    for (const user of ['alice', 'bob']) { await storage.createNote(user, A, { meta: meta(A), files: { 'audio.webm': pattern(300_000) } }); await age(user, A, 'audio.webm', 48 * HOUR) }
    policies.set('alice', { ...base, maxCacheBytes: 1 })
    await storage.trimCache('alice')
    await storage.trimCache('bob')
    expect(await cached('alice', A)).toEqual([])
    expect(await cached('bob', A)).toEqual(['audio.webm'])
  })
})

describe('never remove the only copy', () => {
  const full = async () => {
    const r = await rig()
    await r.storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(300_000) } })
    await r.age('alice', A, 'audio.webm', 48 * HOUR)
    r.policies.set('alice', { ...r.base, maxCacheBytes: 1 })
    return r
  }

  it('keeps the local copy when the person deleted the recording from their Drive by hand', async () => {
    const r = await full()
    r.fake.purge('alice', 'audio.webm')
    expect(await r.storage.trimCache('alice')).toEqual({ freedFiles: 0, freedBytes: 0, skipped: 1 })
    expect(await r.cached('alice', A)).toEqual(['audio.webm'])
  })

  it('keeps it when Drive holds a different size', async () => {
    const r = await full()
    await appendFile(join(r.dir, 'alice', A, 'audio.webm'), 'extra')
    await r.age('alice', A, 'audio.webm', 48 * HOUR) // appending touched it: make it old again so only the size can stop the eviction
    expect((await r.storage.trimCache('alice')).skipped).toBe(1)
    expect(await r.cached('alice', A)).toEqual(['audio.webm'])
  })

  it('keeps it when Drive cannot be asked (access revoked, unreachable)', async () => {
    const r = await full()
    r.fake.revoke('alice')
    expect((await r.storage.trimCache('alice')).skipped).toBe(1)
    expect(await r.cached('alice', A)).toEqual(['audio.webm'])
  })

  it('keeps it when the recording sits in Drive’s trash', async () => {
    const r = await full()
    const folder = r.fake.files('alice').find(file => file.name === A && file.folder)!
    await fetch(`${r.fake.apiBase}/files/${folder.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer tok-alice-1', 'Content-Type': 'application/json' }, body: '{"trashed":true}' })
    expect((await r.storage.trimCache('alice')).skipped).toBe(1)
    expect(await r.cached('alice', A)).toEqual(['audio.webm'])
  })

  it('releaseAudio (drop after sorting) follows the same rule', async () => {
    const r = await rig({ retainAudio: 'drop-after-digest' })
    await r.storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(300_000) } })
    await r.storage.createNote('alice', B, { meta: meta(B), files: { 'audio.webm': pattern(300_000, 1) } })
    r.fake.purge('alice', A) // the whole note folder is gone from Drive
    await r.storage.releaseAudio('alice', A)
    await r.storage.releaseAudio('alice', B)
    expect(await r.cached('alice', A)).toEqual(['audio.webm']) // not proven safe: kept
    expect(await r.cached('alice', B)).toEqual([]) // proven safe: dropped
  })

  it('releaseAudio does nothing for a person whose choice is to keep the audio', async () => {
    const r = await rig({ retainAudio: 'keep' })
    await r.storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(1000) } })
    await r.storage.releaseAudio('alice', A)
    expect(await r.cached('alice', A)).toEqual(['audio.webm'])
  })

  it('a missing cache folder is fine', async () => {
    const r = await rig()
    expect(await r.storage.trimCache('nobody')).toEqual({ freedFiles: 0, freedBytes: 0, skipped: 0 })
    expect(await stat(join(r.dir, 'nobody')).catch(() => null)).toBeNull()
  })
})

describe('deleting a note: Drive’s trash or for good, as the person chose', () => {
  it('trash: the note disappears from the app but is only moved to Drive’s trash, and nothing is erased', async () => {
    const { fake, storage } = await rig({ trashOnDelete: true })
    await storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(300_000), 'transcript.json': encode('{}') } })
    await storage.deleteNote('alice', A)
    expect(await storage.hasNote('alice', A)).toBe(false)
    expect(await storage.listNotes('alice')).toEqual([])
    expect(fake.files('alice').some(file => file.name === A)).toBe(false)
    expect(fake.trashed('alice')).toEqual(expect.arrayContaining([A, 'audio.webm', 'meta.json', 'transcript.json']))
    expect(fake.count(seen => seen.method === 'DELETE')).toBe(0)
    expect(fake.count(seen => seen.method === 'PATCH' && !seen.path.startsWith('/upload'))).toBe(1) // the folder; its files go with it
    expect(await storage.createNote('alice', A, { meta: meta(A) })).toBe(true) // the same id can be used again
  })

  it('permanent: the note is erased, nothing lands in the trash', async () => {
    const { fake, storage } = await rig({ trashOnDelete: false })
    await storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(1000) } })
    await storage.deleteNote('alice', A)
    expect(fake.trashed('alice')).toEqual([])
    expect(fake.files('alice').some(file => file.name === A)).toBe(false)
    expect(fake.count(seen => seen.method === 'DELETE')).toBeGreaterThan(0)
  })

  it('trash also removes the local cache, and a second delete is harmless', async () => {
    const { storage, cached } = await rig({ trashOnDelete: true })
    await storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': pattern(1000) } })
    await storage.deleteNote('alice', A)
    expect(await cached('alice', A)).toEqual([])
    await storage.deleteNote('alice', A)
  })

  it('a failed upload is still cleaned up for good, even when the person’s deletes go to the trash', async () => {
    const { fake, storage } = await rig({ trashOnDelete: true })
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('the microphone fell out')) } })
    await expect(storage.createNote('alice', A, { meta: meta(A), files: { 'audio.webm': broken } })).rejects.toThrow()
    expect(fake.trashed('alice')).toEqual([])
    expect(fake.count(seen => seen.method === 'PATCH' && !seen.path.startsWith('/upload'))).toBe(0)
    expect(fake.files('alice').some(file => file.name === A)).toBe(false)
  })

  it('without a policy provider the storage still erases, as before', async () => {
    const fake = await new FakeDrive().start()
    const dir = await tempDir()
    open.push(async () => { await fake.close(); await dir.clean() })
    const storage = new DriveStorage({ tokens: new FakeTokens(), cacheDir: dir.dir, apiBase: fake.apiBase, uploadBase: fake.uploadBase })
    await storage.createNote('alice', A, { meta: meta(A) })
    await storage.deleteNote('alice', A)
    expect(fake.trashed('alice')).toEqual([])
    expect(fake.count(seen => seen.method === 'DELETE')).toBeGreaterThan(0)
    expect(await storage.trimCache('alice')).toEqual({ freedFiles: 0, freedBytes: 0, skipped: 0 })
  })
})
