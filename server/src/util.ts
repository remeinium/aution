import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PermanentError extends Error {}

/**
 * An AI service said its usage limit is reached (a rate limit, a daily quota, or an empty balance). This is not a failure
 * and never counts toward giving up: the work waits and carries on. `retryAfterMs` is how long the service said to wait,
 * or null when it did not say.
 */
export class RateLimited extends Error {
  readonly retryAfterMs: number | null
  constructor(message: string, retryAfterMs: number | null) { super(message); this.retryAfterMs = retryAfterMs }
}

const UNIT_MS: Record<string, number> = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
}

/** "6m0s", "1h2m3.5s", "20ms", "34s", "2 hours 5 minutes" → milliseconds. Null when nothing in it is a duration. */
export function parseDuration(text: string): number | null {
  let total = 0
  let found = false
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = UNIT_MS[(match[2] as string).toLowerCase()]
    if (unit === undefined) continue
    total += Number(match[1]) * unit
    found = true
  }
  return found ? Math.round(total) : null
}

/**
 * How long an AI service says to wait, read from the places the common ones put it: the standard Retry-After header,
 * OpenAI's x-ratelimit-reset-* durations, Anthropic's reset timestamps, Gemini's retryDelay and the sentence "try again in 2m".
 * Null when the response does not say.
 */
export function parseResetMs(headers: Headers, bodyText: string, now: number = Date.now()): number | null {
  const own = headers.get('x-voicebrain-retry-after-ms') ?? headers.get('retry-after-ms')
  if (own && /^\d+(\.\d+)?$/.test(own.trim())) return Math.round(Number(own))
  const after = headers.get('retry-after')?.trim()
  if (after) {
    if (/^\d+(\.\d+)?$/.test(after)) return Math.round(Number(after) * 1000)
    const date = Date.parse(after)
    if (!Number.isNaN(date)) return Math.max(0, date - now)
  }
  const openai = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'].map(name => headers.get(name)).filter((v): v is string => Boolean(v)).map(parseDuration).filter((v): v is number => v !== null)
  if (openai.length) return Math.max(...openai)
  const anthropic = [...headers.entries()].filter(([name]) => /^anthropic-ratelimit-.*-reset$/.test(name)).map(([, value]) => Date.parse(value) - now).filter(ms => Number.isFinite(ms) && ms > 0)
  if (anthropic.length) return Math.max(...anthropic)
  const delay = /"retryDelay"\s*:\s*"([^"]+)"/.exec(bodyText)?.[1]
  if (delay) { const ms = parseDuration(delay); if (ms !== null) return ms }
  const sentence = /(?:retry|try again|resets?|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(bodyText)?.[1]
  return sentence ? parseDuration(sentence) : null
}

/** What a failing program or service wrote, when it is about a usage limit rather than a fault. */
export const LIMIT_TEXT = /(rate.?limit|usage limit|limit (?:reached|exceeded|will reset)|hit your limit|too many requests|quota (?:exceeded|exhausted)|exceeded your current quota|out of credits?|credit balance is too low|insufficient[_ ]quota)/i

/** How long to wait: what the service said (plus a second, so we do not arrive early), else a pause that grows, never over a week. */
export function limitWaitMs(said: number | null, streak: number): number {
  const fallback = Math.min(3_600_000, 60_000 * 2 ** Math.max(0, streak - 1))
  return Math.min(7 * 86_400_000, Math.max(5_000, said === null ? fallback : said + 1000))
}

/** The note was deleted while it was being worked on. Callers drop their work quietly. */
export class NoteGone extends Error {}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return null }
}

export const writeJson = (path: string, value: unknown) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)

export function slugify(text: string, max = 48): string {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '')
  return slug || 'untitled'
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The wall-clock time where the note was recorded (the app sends its UTC offset). */
export function localParts(iso: string, utcOffsetMinutes: number) {
  const shifted = new Date(new Date(iso).getTime() + utcOffsetMinutes * 60_000)
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][shifted.getUTCDay()] as string
  const sign = utcOffsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(utcOffsetMinutes)
  return { date, time, weekday, offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` }
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  return `${hours ? `${pad(hours)}:` : ''}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}h ${pad(minutes)}m` : minutes ? `${minutes}m ${pad(seconds)}s` : `${seconds}s`
}

/** Retry delay: 5 s doubling up to 15 min, with jitter. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  return Math.round(Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1)) * (0.8 + random() * 0.4))
}

/** A promise queue: tasks run one at a time, in order, and one failure does not stop the next. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const rotation = new Map<string, number>()

/**
 * Sends a request with each configured key in turn. `apiKeys` may hold several keys separated by commas;
 * each call starts from the next key, and a rate-limited (429) key hands over to the next one.
 */
export async function withKeys(apiKeys: string, request: (key: string) => Promise<Response>): Promise<Response> {
  const keys = apiKeys.split(',').map(key => key.trim()).filter(Boolean)
  if (keys.length <= 1) return request(keys[0] ?? '')
  const start = rotation.get(apiKeys) ?? 0
  rotation.set(apiKeys, start + 1)
  let last: Response | null = null
  const waits: number[] = []
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const response = await request(keys[(start + attempt) % keys.length] as string)
    if (response.status !== 429) return response
    const said = parseResetMs(response.headers, await response.clone().text().catch(() => ''))
    if (said !== null) waits.push(said)
    last = response
  }
  // Every key is limited. Report the soonest any of them frees up, because that is when work can carry on.
  if (last && waits.length) {
    const headers = new Headers(last.headers)
    headers.set('x-voicebrain-retry-after-ms', String(Math.min(...waits)))
    return new Response(await last.text(), { status: 429, headers })
  }
  return last as Response
}
