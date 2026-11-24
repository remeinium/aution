import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brain } from '../src/brain.ts'
import { Pipeline } from '../src/pipeline.ts'
import type { CacheTrim } from '../src/storage.ts'
import { tempDir, testConfig } from './helpers.ts'
import { MemoryStorage } from './memory-storage.ts'

let dir: Awaited<ReturnType<typeof tempDir>>
const open: Array<() => Promise<void>> = []
beforeEach(async () => { dir = await tempDir() })
afterEach(async () => { for (const close of open.splice(0)) await close(); await dir.clean() })

async function boot(trim?: () => Promise<CacheTrim>) {
  const storage = new MemoryStorage()
  if (trim) (storage as MemoryStorage & { trimCache?: () => Promise<CacheTrim> }).trimCache = trim
  const brain = new Brain(testConfig(dir.dir), undefined, storage)
  await brain.init()
  const logs: string[] = []
  const pipeline = new Pipeline(brain, { log: message => logs.push(message) })
  open.push(async () => { await pipeline.stop(); brain.close() })
  return { pipeline, logs }
}

describe('keeping the audio cache under its cap', () => {
  it('trims after a pass, but at most every ten minutes, unless asked to now', async () => {
    let calls = 0
    const { pipeline, logs } = await boot(async () => { calls += 1; return { freedFiles: 2, freedBytes: 3 * 1024 * 1024, skipped: 0 } })
    pipeline.kick(); await pipeline.idle()
    pipeline.kick(); await pipeline.idle()
    expect(calls).toBe(1)
    await pipeline.trimCache(true)
    expect(calls).toBe(2)
    expect(logs).toContain('freed 2 cached recordings (3 MB); Drive still has them')
  })

  it('a trim that fails is only logged, and the next pass still runs', async () => {
    const { pipeline, logs } = await boot(async () => { throw new Error('Drive is down') })
    pipeline.kick(); await pipeline.idle()
    expect(logs.some(line => line.includes('could not trim the audio cache: Drive is down'))).toBe(true)
    await expect(pipeline.trimCache(true)).resolves.toBeUndefined()
  })

  it('a backend with no cache is simply left alone', async () => {
    const { pipeline, logs } = await boot()
    pipeline.kick(); await pipeline.idle()
    await pipeline.trimCache(true)
    expect(logs).toEqual([])
  })
})
