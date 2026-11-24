import { beforeEach, describe, expect, it, vi } from 'vitest'

const kv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../src/lib/db', () => ({ getKv: async (key: string) => kv.get(key), setKv: async (key: string, value: unknown) => { kv.set(key, value) } }))

import { checkForUpdate, checkNow, dismiss, isDismissed, releaseFrom } from '../src/native/update'

const release = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/remeinium/aution/releases/tag/${tag}`, assets: [{ name: 'aution.apk', browser_download_url: `https://github.com/remeinium/aution/releases/download/${tag}/aution.apk` }] })
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

beforeEach(() => kv.clear())

describe('checking for an update', () => {
  it('reports a newer release, the same version, and an older one', async () => {
    expect((await checkNow({ fetchImpl: answer(release('v0.2.3')) as never, current: '0.2.2' })).status).toBe('update')
    kv.clear()
    expect((await checkNow({ fetchImpl: answer(release('v0.2.2')) as never, current: '0.2.2' })).status).toBe('current')
    kv.clear()
    expect((await checkNow({ fetchImpl: answer(release('v0.2.1')) as never, current: '0.2.2' })).status).toBe('current')
  })

  it('remembers the answer for a few hours, and `force` asks again', async () => {
    const fetchImpl = answer(release('v0.2.3'))
    await checkNow({ fetchImpl: fetchImpl as never, current: '0.2.2', now: 1_000 })
    await checkNow({ fetchImpl: fetchImpl as never, current: '0.2.2', now: 1_000 + 60_000 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await checkNow({ fetchImpl: fetchImpl as never, current: '0.2.2', now: 1_000 + 60_000, force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await checkNow({ fetchImpl: fetchImpl as never, current: '0.2.2', now: 1_000 + 7 * 3_600_000 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('says "error" (and the background check says nothing new) when GitHub cannot be reached or refuses', async () => {
    expect((await checkNow({ fetchImpl: (async () => { throw new Error('offline') }) as never, current: '0.2.2' })).status).toBe('error')
    expect((await checkNow({ fetchImpl: answer({ message: 'rate limit' }, 403) as never, current: '0.2.2' })).status).toBe('error')
    expect(await checkForUpdate(1, (async () => { throw new Error('offline') }) as never)).toBeNull()
  })

  it('ignores a release whose file is not from this repository\'s downloads', async () => {
    const bad = { tag_name: 'v9.9.9', assets: [{ name: 'aution.apk', browser_download_url: 'https://evil.example/aution.apk' }] }
    expect(releaseFrom(bad)).toBeNull()
    expect((await checkNow({ fetchImpl: answer(bad) as never, current: '0.2.2' })).status).toBe('current')
  })
})

describe('"Not now" on the banner', () => {
  it('is remembered for that version only', async () => {
    expect(await isDismissed('0.2.3')).toBe(false)
    await dismiss('0.2.3')
    expect(await isDismissed('0.2.3')).toBe(true)
    expect(await isDismissed('0.2.4')).toBe(false) // a newer release shows the banner again
  })
})
