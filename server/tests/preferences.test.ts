import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, connectDrive, signIn, type Identity } from './fake-google.ts'
import { FakeDrive } from './fake-drive.ts'
import { INGEST, NOTE_ID, freePort, run, tempDir, testConfig, upload, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const json = { 'Content-Type': 'application/json' }
const KEY = randomBytes(32).toString('base64')

let google: FakeGoogle
let drive: FakeDrive
let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running
let origin = ''

beforeAll(async () => { google = await FakeGoogle.start(); drive = await new FakeDrive().start() })
afterAll(async () => { delete process.env.STORAGE_BACKEND; delete process.env.DRIVE_RETAIN_AUDIO; await google.close(); await drive.close() })

async function boot(backend: 'drive' | 'local') {
  if (backend === 'drive') process.env.STORAGE_BACKEND = 'drive'; else delete process.env.STORAGE_BACKEND
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, allowedEmails: [ALICE.email], driveEnabled: true, tokenEncryptionKey: KEY, workerEnabled: false }), fetch, { googleEndpoints: google.endpoints, driveApi: { apiBase: drive.apiBase, uploadBase: drive.uploadBase } })
}
beforeEach(async () => {
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
  dir = await tempDir()
})
afterEach(async () => { vi.restoreAllMocks(); await server.stop(); drive.purge('alice', 'aution'); delete process.env.DRIVE_RETAIN_AUDIO; await dir.clean() })

async function aliceDevice(): Promise<string> {
  const browser = new Browser()
  expect((await signIn(browser, origin, google, ALICE)).status).toBe(302)
  expect((await connectDrive(browser, origin, google, ALICE)).status).toBe(200)
  drive.tokenAccounts.set(await (server.app.drive as { accessToken(id: string): Promise<string> }).accessToken(ALICE.sub), 'alice')
  const start = (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 'Phone' }) })).json()) as { pairId: string; pollToken: string; userCode: string }
  await browser.form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve' }, { Origin: origin })
  return ((await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }) })).json()) as { token: string }).token
}
const get = (token: string) => fetch(`${origin}/v1/preferences`, { headers: { Authorization: `Bearer ${token}` } })
const put = (token: string, body: unknown) => fetch(`${origin}/v1/preferences`, { method: 'PUT', headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
const DEFAULTS = { audioCache: 'keep', audioCacheMaxMb: 0, deleteMode: 'trash' }

describe('GET and PUT /v1/preferences with Drive storage', () => {
  beforeEach(() => boot('drive'))

  it('answers with the defaults, which never delete anything, and the size of the server’s audio cache', async () => {
    const token = await aliceDevice()
    const answer = await get(token)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('cache-control')).toBe('no-store')
    expect(await answer.json()).toEqual({ drive: true, prefs: DEFAULTS, defaults: DEFAULTS, cache: { bytes: 0, files: 0 } })
    expect((await upload(origin, { id: NOTE_ID, token, audio: new Uint8Array(5000).fill(7) })).status).toBe(201)
    expect(((await (await get(token)).json()) as { cache: unknown }).cache).toEqual({ bytes: 5000, files: 1 })
  })

  it('saves a change, returns the whole picture, and keeps the rest', async () => {
    const token = await aliceDevice()
    const first = await put(token, { audioCacheMaxMb: 2048 })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ drive: true, prefs: { ...DEFAULTS, audioCacheMaxMb: 2048 }, defaults: DEFAULTS })
    expect(((await (await put(token, { deleteMode: 'permanent', audioCache: 'after-sorting' })).json()) as { prefs: unknown }).prefs).toEqual({ audioCache: 'after-sorting', audioCacheMaxMb: 2048, deleteMode: 'permanent' })
    expect(((await (await get(token)).json()) as { prefs: unknown }).prefs).toEqual({ audioCache: 'after-sorting', audioCacheMaxMb: 2048, deleteMode: 'permanent' })
  })

  it('refuses bad input with 400 and a readable message, and changes nothing', async () => {
    const token = await aliceDevice()
    for (const body of [{ audioCache: 'always' }, { audioCacheMaxMb: -5 }, { deleteMode: 1 }, { shoeSize: 9 }, [], 'x']) {
      const answer = await put(token, body)
      expect(answer.status, JSON.stringify(body)).toBe(400)
      expect(((await answer.json()) as { error: string }).error).toMatch(/\w/)
    }
    expect((await fetch(`${origin}/v1/preferences`, { method: 'PUT', headers: { ...json, Authorization: `Bearer ${token}` }, body: '{not json' })).status).toBe(400)
    expect(((await (await get(token)).json()) as { prefs: unknown }).prefs).toEqual(DEFAULTS)
  })

  it('needs a connected device', async () => {
    expect((await fetch(`${origin}/v1/preferences`)).status).toBe(401)
    expect((await fetch(`${origin}/v1/preferences`, { method: 'PUT', headers: json, body: '{}' })).status).toBe(401)
    expect((await get('vbd_nope')).status).toBe(401)
  })

  it('the choice really governs deleting: by default a note goes to Drive’s trash; after choosing "permanent" it is erased', async () => {
    const token = await aliceDevice()
    const second = '55555555-5555-4555-8555-555555555555'
    expect((await upload(origin, { id: NOTE_ID, token })).status).toBe(201)
    expect((await upload(origin, { id: second, token })).status).toBe(201)
    expect((await fetch(`${origin}/v1/notes/${NOTE_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204)
    expect(drive.trashed('alice')).toContain(NOTE_ID)
    expect(drive.files('alice').some(file => file.name === NOTE_ID)).toBe(false)

    expect((await put(token, { deleteMode: 'permanent' })).status).toBe(200)
    expect((await fetch(`${origin}/v1/notes/${second}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204)
    expect(drive.trashed('alice')).not.toContain(second)
    expect(drive.files('alice').some(file => file.name === second)).toBe(false)
  })

  it('the choice survives a restart', async () => {
    const token = await aliceDevice()
    await put(token, { audioCacheMaxMb: 300 })
    await server.stop()
    await boot('drive')
    expect(((await (await get(token)).json()) as { prefs: { audioCacheMaxMb: number } }).prefs.audioCacheMaxMb).toBe(300)
  })

  it('someone signed in without a connected Drive still sees and sets their choices', async () => {
    const browser = new Browser()
    expect((await signIn(browser, origin, google, ALICE)).status).toBe(302)
    const start = (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 'Phone' }) })).json()) as { pairId: string; pollToken: string; userCode: string }
    await browser.form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve' }, { Origin: origin })
    const token = ((await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }) })).json()) as { token: string }).token
    expect(await (await get(token)).json()).toEqual({ drive: true, prefs: DEFAULTS, defaults: DEFAULTS, cache: null })
    expect((await put(token, { deleteMode: 'permanent' })).status).toBe(200)
  })

  it('the owner identity has no such choices: its audio is on this disk and is the only copy', async () => {
    const answer = await get(INGEST)
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ drive: false, prefs: DEFAULTS, defaults: DEFAULTS, cache: null })
    const refused = await put(INGEST, { audioCacheMaxMb: 1 })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'no-drive-storage' })
  })
})

describe('the instance default comes from DRIVE_RETAIN_AUDIO', () => {
  it('drop-after-digest in the environment shows up as "after-sorting" for people who never chose', async () => {
    process.env.DRIVE_RETAIN_AUDIO = 'drop-after-digest'
    await boot('drive')
    const token = await aliceDevice()
    expect(((await (await get(token)).json()) as { prefs: { audioCache: string } }).prefs.audioCache).toBe('after-sorting')
    expect(((await (await put(token, { audioCache: 'keep' })).json()) as { prefs: { audioCache: string } }).prefs.audioCache).toBe('keep')
  })
})

describe('with notes on this server’s own disk (STORAGE_BACKEND=local)', () => {
  it('there is nothing to choose: drive is false and a change is refused', async () => {
    await boot('local')
    expect(await (await get(INGEST)).json()).toEqual({ drive: false, prefs: DEFAULTS, defaults: DEFAULTS, cache: null })
    expect((await put(INGEST, { deleteMode: 'permanent' })).status).toBe(409)
  })
})
