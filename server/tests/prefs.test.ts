import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrefsError, UserPrefs, type Prefs } from '../src/prefs.ts'
import { tempDir } from './helpers.ts'

const DEFAULTS: Prefs = { audioCache: 'keep', audioCacheMaxMb: 0, deleteMode: 'trash' }
const open: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of open.splice(0)) await close() })

async function prefs(defaults: Prefs = DEFAULTS) {
  const dir = await tempDir()
  const path = join(dir.dir, 'prefs.sqlite')
  const make = () => { const made = new UserPrefs(path, defaults); open.push(async () => made.close()); return made }
  open.push(dir.clean)
  return { make, path }
}

describe('per-person preferences', () => {
  it('start at the defaults, and the defaults never delete anything', async () => {
    const { make } = await prefs()
    const store = make()
    expect(store.get('alice')).toEqual(DEFAULTS)
    expect(store.policyFor('alice')).toEqual({ retainAudio: 'keep', maxCacheBytes: 0, trashOnDelete: true })
  })

  it('merges a partial change, keeps the rest, and turns it into a storage policy', async () => {
    const store = (await prefs()).make()
    expect(store.set('alice', { audioCacheMaxMb: 512 })).toEqual({ ...DEFAULTS, audioCacheMaxMb: 512 })
    expect(store.set('alice', { audioCache: 'after-sorting', deleteMode: 'permanent' })).toEqual({ audioCache: 'after-sorting', audioCacheMaxMb: 512, deleteMode: 'permanent' })
    expect(store.policyFor('alice')).toEqual({ retainAudio: 'drop-after-digest', maxCacheBytes: 512 * 1024 * 1024, trashOnDelete: false })
    expect(store.set('alice', {})).toEqual(store.get('alice'))
  })

  it('keeps each person’s choices to themselves, and across a restart', async () => {
    const { make } = await prefs()
    make().set('alice', { audioCacheMaxMb: 100 })
    const again = make()
    expect(again.get('alice').audioCacheMaxMb).toBe(100)
    expect(again.get('bob').audioCacheMaxMb).toBe(0)
  })

  it('a person who never chose follows the instance defaults, also when those change', async () => {
    const { make, path } = await prefs()
    make().set('alice', { deleteMode: 'permanent' })
    const changed = new UserPrefs(path, { ...DEFAULTS, audioCache: 'after-sorting' })
    open.push(async () => changed.close())
    expect(changed.get('alice')).toEqual({ audioCache: 'after-sorting', audioCacheMaxMb: 0, deleteMode: 'permanent' })
    expect(changed.get('bob').audioCache).toBe('after-sorting')
  })

  it('refuses anything it does not understand, and applies none of a bad request', async () => {
    const store = (await prefs()).make()
    const bad: unknown[] = [{ audioCache: 'always' }, { deleteMode: 'shred' }, { audioCacheMaxMb: -1 }, { audioCacheMaxMb: 1.5 }, { audioCacheMaxMb: '10' }, { audioCacheMaxMb: 1_000_001 }, { audioCacheMaxMb: null }, { colour: 'red' }, null, [], 'keep', 7]
    for (const patch of bad) expect(() => store.set('alice', patch), JSON.stringify(patch)).toThrow(PrefsError)
    expect(() => store.set('alice', { audioCacheMaxMb: 5, deleteMode: 'nope' })).toThrow(PrefsError)
    expect(store.get('alice')).toEqual(DEFAULTS) // the valid half was not applied either
    expect(store.set('alice', { audioCacheMaxMb: 1_000_000 }).audioCacheMaxMb).toBe(1_000_000)
    expect(store.set('alice', { audioCacheMaxMb: 0 }).audioCacheMaxMb).toBe(0)
  })

  it('refuses a user id that could be a path', async () => {
    const store = (await prefs()).make()
    expect(() => store.get('../etc')).toThrow()
  })
})
