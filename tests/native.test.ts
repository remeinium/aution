// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { externalUrl } from '../src/native/links'
import { choose } from '../src/native/runtime'
import { TOKEN_KEY, readToken, writeToken } from '../src/native/secrets'
import type { SecureStore } from '../src/native/types'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/types'

function memoryStore(separate: boolean, initial: Record<string, string> = {}): SecureStore & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    separate,
    get: async key => data[key] ?? null,
    set: async (key, value) => { data[key] = value },
    remove: async key => { delete data[key] },
  }
}

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, endpoint: 'https://notes.example.com', ...patch })

describe('choose', () => {
  it('uses the web implementation in a browser', () => {
    expect(choose({ web: () => 'web', tauri: () => 'tauri' }, false)).toBe('web')
  })
  it('uses the native implementation inside the app', () => {
    expect(choose({ web: () => 'web', tauri: () => 'tauri' }, true)).toBe('tauri')
  })
  it('falls back to the web implementation when there is no native one yet', () => {
    expect(choose({ web: () => 'web' }, true)).toBe('web')
  })
  it('only builds the implementation it picks', () => {
    const tauri = vi.fn(() => 'tauri')
    choose({ web: () => 'web', tauri }, false)
    expect(tauri).not.toHaveBeenCalled()
  })
})

describe('externalUrl', () => {
  const base = 'https://tauri.localhost/#/settings'
  it('accepts web pages, resolved against the app', () => {
    expect(externalUrl('https://notes.example.com/pair?c=AB', base)).toBe('https://notes.example.com/pair?c=AB')
    expect(externalUrl('guide/one.png', base)).toBe('https://tauri.localhost/guide/one.png')
  })
  it('refuses anything that is not http or https', () => {
    for (const href of ['javascript:alert(1)', 'intent://scan/#Intent;scheme=x;end', 'file:///data/data/x', 'content://x', '', null, undefined]) {
      expect(externalUrl(href, base)).toBeNull()
    }
  })
})

describe('the device token and the secure store', () => {
  it('on the web the token stays in the settings, as before', async () => {
    const store = memoryStore(false)
    const persist = vi.fn(async () => {})
    expect(await readToken(settings({ token: 'vbd_web' }), store, persist)).toBe('vbd_web')
    expect(await writeToken(settings({ token: 'vbd_new' }), 'vbd_web', store)).toMatchObject({ token: 'vbd_new' })
    expect(persist).not.toHaveBeenCalled()
    expect(store.data).toEqual({})
  })

  it('natively the token is read from the secure store, never from IndexedDB', async () => {
    const store = memoryStore(true, { [TOKEN_KEY]: 'vbd_secure' })
    expect(await readToken(settings({ token: '' }), store, async () => {})).toBe('vbd_secure')
  })

  it('a token left in IndexedDB from before is moved to the secure store and wiped', async () => {
    const store = memoryStore(true)
    const persist = vi.fn(async (_settings: Settings) => {})
    expect(await readToken(settings({ token: 'vbd_old' }), store, persist)).toBe('vbd_old')
    expect(store.data[TOKEN_KEY]).toBe('vbd_old')
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ token: '' }))
  })

  it('saving writes the token to the secure store and an empty one to IndexedDB', async () => {
    const store = memoryStore(true)
    const stored = await writeToken(settings({ token: 'vbd_paired' }), '', store)
    expect(stored.token).toBe('')
    expect(stored.endpoint).toBe('https://notes.example.com')
    expect(store.data[TOKEN_KEY]).toBe('vbd_paired')
  })

  it('signing out removes the token from the secure store', async () => {
    const store = memoryStore(true, { [TOKEN_KEY]: 'vbd_paired' })
    await writeToken(settings({ token: '' }), 'vbd_paired', store)
    expect(store.data[TOKEN_KEY]).toBeUndefined()
  })
})
