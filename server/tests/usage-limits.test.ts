import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chatJson, digestNote, type DigestPart } from '../src/digest.ts'
import { runCli } from '../src/llm-cli.ts'
import type { NoteMeta, Transcript } from '../src/types.ts'
import { PermanentError, RateLimited, limitWaitMs, parseDuration, parseResetMs, withKeys } from '../src/util.ts'
import { NOTE_ID, fakeLlm, fakeStt, run, tempDir, testConfig, upload, waitFor, type Fake } from './helpers.ts'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const headers = (init: Record<string, string>) => new Headers(init)
const meta = { id: NOTE_ID, createdAt: '2026-10-30T03:42:00.000Z', title: '', timezone: 'Asia/Colombo', utcOffsetMinutes: 330 } as NoteMeta

describe('reading how long a service says to wait', () => {
  it('reads durations in the forms services use', () => {
    expect(parseDuration('34s')).toBe(34_000)
    expect(parseDuration('6m0s')).toBe(360_000)
    expect(parseDuration('1h2m3.5s')).toBe(3_723_500)
    expect(parseDuration('20ms')).toBe(20)
    expect(parseDuration('2 hours 5 minutes')).toBe(7_500_000)
    expect(parseDuration('soon')).toBeNull()
  })

  it('prefers the standard header, in seconds or as a date', () => {
    expect(parseResetMs(headers({ 'retry-after': '30' }), '', NOW)).toBe(30_000)
    expect(parseResetMs(headers({ 'retry-after': 'Tue, 03 Nov 2026 12:01:30 GMT' }), '', NOW)).toBe(90_000)
    expect(parseResetMs(headers({ 'retry-after-ms': '1500' }), '', NOW)).toBe(1500)
    expect(parseResetMs(headers({ 'retry-after': '5', 'x-ratelimit-reset-tokens': '6m0s' }), '', NOW)).toBe(5000)
  })

  it('reads OpenAI-style reset durations (the later one) and Anthropic-style reset times', () => {
    expect(parseResetMs(headers({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }), '', NOW)).toBe(360_000)
    expect(parseResetMs(headers({ 'anthropic-ratelimit-requests-reset': '2026-11-03T12:00:10Z', 'anthropic-ratelimit-tokens-reset': '2026-11-03T12:02:00Z' }), '', NOW)).toBe(120_000)
  })

  it('reads Gemini’s retryDelay and a plain sentence, and says nothing when there is nothing to read', () => {
    expect(parseResetMs(headers({}), '{"error":{"details":[{"@type":"x.RetryInfo","retryDelay":"34s"}]}}', NOW)).toBe(34_000)
    expect(parseResetMs(headers({}), 'Rate limit reached. Please try again in 1.5s.', NOW)).toBe(1500)
    expect(parseResetMs(headers({}), 'Your limit will reset in 2 hours and 10 minutes', NOW)).toBe(7_800_000)
    expect(parseResetMs(headers({}), 'too many requests', NOW)).toBeNull()
  })

  it('waits what it was told (plus a second), a growing pause when it was not, and never more than a week', () => {
    expect(limitWaitMs(30_000, 1)).toBe(31_000)
    expect(limitWaitMs(0, 1)).toBe(5_000) // never a tight loop
    expect(limitWaitMs(null, 1)).toBe(60_000)
    expect(limitWaitMs(null, 3)).toBe(240_000)
    expect(limitWaitMs(null, 20)).toBe(3_600_000)
    expect(limitWaitMs(30 * 86_400_000, 1)).toBe(7 * 86_400_000)
  })

  it('with several keys all at their limit, reports the soonest any frees up', async () => {
    const waits: Record<string, string> = { a: '300', b: '45', c: '120' }
    const response = await withKeys('a,b,c', async key => new Response('{}', { status: 429, headers: { 'retry-after': waits[key] as string } }))
    expect(response.status).toBe(429)
    expect(parseResetMs(response.headers, '', NOW)).toBe(45_000)
    expect((await withKeys('a,b', async key => new Response('ok', { status: key === 'a' ? 429 : 200 }))).status).toBe(200)
  })
})

describe('providers turn "limit reached" into waiting, not failing', () => {
  let openai: Fake
  let anthropic: Server
  let anthropicReply: { status: number; headers: Record<string, string>; body: unknown } = { status: 200, headers: {}, body: {} }
  let anthropicUrl = ''
  const llm = (extra: Record<string, unknown> = {}) => ({ provider: 'openai' as const, baseUrl: openai.url, apiKey: 'k', model: 'm', maxInputChars: 20_000, ...extra })
  const claude = () => ({ provider: 'anthropic' as const, baseUrl: anthropicUrl, apiKey: 'k', model: 'm', maxInputChars: 20_000 })
  const caught = (promise: Promise<unknown>) => promise.catch((error: Error) => error)

  beforeAll(async () => {
    openai = await fakeLlm()
    anthropic = createServer((_request, response) => { response.writeHead(anthropicReply.status, { 'Content-Type': 'application/json', ...anthropicReply.headers }); response.end(JSON.stringify(anthropicReply.body)) })
    await new Promise<void>(done => anthropic.listen(0, '127.0.0.1', done))
    anthropicUrl = `http://127.0.0.1:${(anthropic.address() as { port: number }).port}`
  })
  afterAll(async () => { await openai.close(); await new Promise<void>(done => anthropic.close(() => done())) })
  afterEach(() => { openai.respond(() => null) })

  it('an OpenAI-compatible 429 carries the wait it was given', async () => {
    openai.respond(() => ({ status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'Rate limit reached' } } }))
    const error = await caught(chatJson(llm(), 's', 'u'))
    expect(error).toBeInstanceOf(RateLimited)
    expect((error as RateLimited).retryAfterMs).toBe(30_000)
    openai.respond(() => ({ status: 429, body: { error: { details: [{ retryDelay: '34s' }] } } }))
    expect(((await caught(chatJson(llm(), 's', 'u'))) as RateLimited).retryAfterMs).toBe(34_000)
    openai.respond(() => ({ status: 429, body: { error: { message: 'slow down' } } }))
    expect(((await caught(chatJson(llm(), 's', 'u'))) as RateLimited).retryAfterMs).toBeNull() // unknown: the pipeline backs off
  })

  it('an empty balance is waiting too, checked hourly, and says so', async () => {
    openai.respond(() => ({ status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } }))
    const error = (await caught(chatJson(llm(), 's', 'u'))) as RateLimited
    expect(error).toBeInstanceOf(RateLimited)
    expect(error.message).toMatch(/out of credit/)
    expect(error.retryAfterMs).toBe(3_600_000)
    openai.respond(() => ({ status: 402, body: { error: { message: 'Insufficient credits' } } }))
    expect(await caught(chatJson(llm(), 's', 'u'))).toBeInstanceOf(RateLimited)
  })

  it('a wrong key and a server fault are still what they were', async () => {
    openai.respond(() => ({ status: 401, body: { error: { message: 'bad key' } } }))
    expect(await caught(chatJson(llm(), 's', 'u'))).toBeInstanceOf(PermanentError)
    openai.respond(() => ({ status: 500, body: { error: { message: 'oops' } } }))
    const fault = await caught(chatJson(llm(), 's', 'u'))
    expect(fault).not.toBeInstanceOf(RateLimited)
    expect(fault).not.toBeInstanceOf(PermanentError)
  })

  it('Anthropic: a 429 with its headers, and the 400 it sends for an empty balance', async () => {
    anthropicReply = { status: 429, headers: { 'retry-after': '75', 'anthropic-ratelimit-requests-reset': '2099-01-01T00:00:00Z' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } } }
    expect(((await caught(chatJson(claude(), 's', 'u'))) as RateLimited).retryAfterMs).toBe(75_000)
    anthropicReply = { status: 400, headers: {}, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }
    const empty = (await caught(chatJson(claude(), 's', 'u'))) as RateLimited
    expect(empty).toBeInstanceOf(RateLimited)
    expect(empty.retryAfterMs).toBe(3_600_000)
    anthropicReply = { status: 400, headers: {}, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is too large' } } }
    expect(await caught(chatJson(claude(), 's', 'u'))).toBeInstanceOf(PermanentError)
    anthropicReply = { status: 529, headers: {}, body: { type: 'error', error: { type: 'overloaded_error' } } }
    expect(await caught(chatJson(claude(), 's', 'u'))).not.toBeInstanceOf(RateLimited)
  })

  it('a long recording keeps the pieces it finished, and the next try does only what is left', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of a long ramble.`).join(' ')
    const long = { text } as Transcript
    let stored = null as { key: string; parts: DigestPart[] } | null
    const progress = {
      load: async (key: string) => (stored?.key === key ? stored.parts : []),
      save: async (key: string, parts: DigestPart[]) => { stored = { key, parts: structuredClone(parts) } },
    }
    const config = llm({ maxInputChars: 140 })
    const before = openai.requests.length
    openai.respond(index => (index - before >= 2 ? { status: 429, headers: { 'retry-after': '60' }, body: {} } : null)) // the third call is refused
    const error = await caught(digestNote(config, meta, long, { projects: [], people: [] }, fetch, progress))
    expect(error).toBeInstanceOf(RateLimited)
    expect(stored?.parts).toHaveLength(2) // the two finished pieces were saved

    openai.respond(() => null)
    const mark = openai.requests.length
    const digest = await digestNote(config, meta, long, { projects: [], people: [] }, fetch, progress)
    const calls = openai.requests.length - mark
    const pieces = Math.ceil(text.length / 140)
    expect(pieces).toBeGreaterThanOrEqual(3)
    expect(calls).toBe(pieces - 2 + 1) // the unfinished pieces, plus the one call that joins title and summary
    expect(digest.title).toBeTruthy()
  })

  it('saved pieces are never reused for different text', async () => {
    const stored = { key: '3:9999', parts: [{ title: 'old' } as DigestPart] }
    const progress = { load: async (key: string) => (stored.key === key ? stored.parts : []), save: async () => undefined }
    const text = Array.from({ length: 12 }, (_, i) => `Another sentence ${i + 1} for a different recording.`).join(' ')
    const mark = openai.requests.length
    await digestNote(llm({ maxInputChars: 140 }), meta, { text } as Transcript, { projects: [], people: [] }, fetch, progress)
    expect(openai.requests.length - mark).toBeGreaterThanOrEqual(4) // all pieces were sorted again
  })
})

describe('an agent program that is at its limit', () => {
  let dir = ''
  const script = async (name: string, body: string) => { const path = join(dir, name); await writeFile(path, body); await chmod(path, 0o755); return path }
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cli-limit-')) })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('is waiting, not failing, and reads "in 2 hours" from what it printed', async () => {
    const path = await script('limit.cjs', `console.error('Claude usage limit reached. Your limit will reset in 2 hours.');process.exit(1)`)
    const error = (await runCli(['node', path], 'x').catch((caught: Error) => caught)) as RateLimited
    expect(error).toBeInstanceOf(RateLimited)
    expect(error.retryAfterMs).toBe(7_200_000)
  })

  it('catches the limit message of a program that still exits 0, and leaves ordinary failures alone', async () => {
    const quiet = await script('exit0.cjs', `console.log('You have hit your limit. Try again in 30 minutes.')`)
    const error = await chatJson({ provider: 'cli', baseUrl: '', apiKey: '', model: 'a', command: ['node', quiet], maxInputChars: 1 }, 's', 'u').catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(RateLimited)
    expect((error as RateLimited).retryAfterMs).toBe(1_800_000)
    const broken = await script('broken.cjs', `console.error('segfault');process.exit(2)`)
    expect(await runCli(['node', broken], 'x').catch((caught: Error) => caught)).not.toBeInstanceOf(RateLimited)
  })
})

describe('in the running server', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>
  let stt: Fake
  let llm: Fake
  const SECOND = '44444444-4444-4444-8444-444444444444'
  const config = () => testConfig(dir.dir, {
    stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'w', language: 'en', maxMb: 24, prompt: '' },
    llm: { provider: 'openai', baseUrl: llm.url, apiKey: '', model: 'l', maxInputChars: 20_000 },
  })
  const stateOf = async (server: Awaited<ReturnType<typeof run>>, id = NOTE_ID) => server.app.brain.store.state(id)
  const asked = () => llm.requests.length

  afterEach(async () => { await stt?.close(); await llm?.close(); await dir?.clean() })
  const setup = async () => { dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm() }

  it('waits out the limit by itself: the note is saved, not failed, and gets sorted when the limit is over', async () => {
    await setup()
    llm.respond(index => (index === 0 ? { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'Rate limit reached' } } } : null))
    const server = await run(config())
    try {
      await upload(server.base)
      await waitFor(() => server.app.brain.index.note(NOTE_ID), 'the note to be written down')
      await waitFor(async () => (await stateOf(server)).nextAttemptAt !== null, 'the note to start waiting')
      const waiting = await stateOf(server)
      expect(waiting).toMatchObject({ failed: false, attempts: 0, stage: 'digest' }) // not counted against the note
      expect(waiting.lastError).toMatch(/usage limit to reset/)
      expect(server.app.brain.index.note(NOTE_ID)).toMatchObject({ digested: 0 }) // written down and searchable meanwhile
      expect((await server.app.pipeline.status()).sortingPausedUntil).toMatch(/^2026|^20\d\d-/)
      await waitFor(() => server.app.brain.index.note(NOTE_ID)?.digested === 1, 'the note to be sorted after the limit', 20_000)
      expect(asked()).toBe(2) // one refusal, one success
      expect((await server.app.pipeline.status()).sortingPausedUntil).toBeNull()
      await waitFor(async () => (await stateOf(server)).lastError === null, 'the waiting message to be cleared')
      expect(await stateOf(server)).toMatchObject({ attempts: 0, failed: false, nextAttemptAt: null })
    } finally { await server.stop() }
  })

  it('does not send other notes to a service that is refusing, then sorts them all', async () => {
    await setup()
    llm.respond(index => (index === 0 ? { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'limit' } } } : null))
    const server = await run(config())
    try {
      await upload(server.base)
      await waitFor(() => server.app.brain.index.note(NOTE_ID), 'the first note')
      await upload(server.base, { id: SECOND })
      await waitFor(() => server.app.brain.index.note(SECOND), 'the second note to be written down')
      await new Promise(done => setTimeout(done, 500))
      expect(asked()).toBe(1) // only the refused request: the second note was held back, not sent to be refused too
      expect(server.app.brain.index.note(SECOND)).toMatchObject({ digested: 0 })
      await waitFor(() => server.app.brain.index.note(NOTE_ID)?.digested === 1 && server.app.brain.index.note(SECOND)?.digested === 1, 'both notes to be sorted', 25_000)
      expect(asked()).toBe(3)
    } finally { await server.stop() }
  })

  it('keeps waiting across a restart, without asking the service again before the time is up', async () => {
    await setup()
    llm.respond(() => ({ status: 429, headers: { 'retry-after': '3600' }, body: {} }))
    let server = await run(config())
    await upload(server.base)
    await waitFor(async () => (await stateOf(server)).nextAttemptAt !== null, 'the note to start waiting')
    const until = (await stateOf(server)).nextAttemptAt as number
    expect(until - Date.now()).toBeGreaterThan(3_500_000)
    await server.stop()
    server = await run(config())
    try {
      await new Promise(done => setTimeout(done, 600))
      expect(asked()).toBe(1) // not asked again
      expect(await stateOf(server)).toMatchObject({ failed: false, nextAttemptAt: until })
    } finally { await server.stop() }
  })

  it('a service that keeps refusing never makes the note fail, however many times', async () => {
    await setup()
    llm.respond(() => ({ status: 429, headers: { 'retry-after': '0' }, body: {} })) // refuses, and says "no wait" (the server waits at least a few seconds)
    const server = await run({ ...config(), maxAttempts: 2 })
    try {
      await upload(server.base)
      await waitFor(async () => (await stateOf(server)).nextAttemptAt !== null, 'the note to start waiting')
      expect(await stateOf(server)).toMatchObject({ failed: false, attempts: 0 })
      expect((await server.app.pipeline.status()).failed).toEqual([])
    } finally { await server.stop() }
  })
})
