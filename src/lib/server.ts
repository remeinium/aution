import { normalizeEndpoint } from './endpoint'
import { errorMessage } from './errors'
import type { Settings } from './types'

type Fetch = typeof fetch
type Credentials = Pick<Settings, 'endpoint' | 'token'>

/** A problem talking to the server, worded for the person using the app. */
export class ServerError extends Error {
  readonly status: number
  constructor(message: string, status = 0) { super(message); this.status = status }
}

export function authHeaders(settings: Pick<Settings, 'token'>): Record<string, string> {
  return settings.token ? { Authorization: `Bearer ${settings.token}` } : {}
}

async function call(settings: Credentials, path: string, init: RequestInit, fetchImpl: Fetch): Promise<Response> {
  const endpoint = normalizeEndpoint(settings.endpoint)
  if (!endpoint) throw new ServerError('No server is set up yet.')
  try {
    return await fetchImpl(`${endpoint}${path}`, { ...init, headers: { ...authHeaders(settings), ...(init.headers as Record<string, string> | undefined) }, signal: init.signal ?? AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new ServerError(`Could not reach the server. ${errorMessage(error)}`)
  }
}

const refused = (response: Response) => response.status === 401 || response.status === 403
  ? new ServerError('This device is no longer connected. Connect it again in Settings.', response.status)
  : new ServerError(`The server answered ${response.status}.`, response.status)

/** Deletes a note from the server for good. A note the server no longer has counts as deleted. */
export async function deleteOnServer(settings: Credentials, id: string, fetchImpl: Fetch = fetch): Promise<void> {
  const response = await call(settings, `/v1/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl)
  if (response.status === 204 || response.status === 404) return
  throw refused(response)
}

/** Sends a rename or new tags. Resolves to "gone" when the server does not have the note. */
export async function editOnServer(settings: Credentials, id: string, edit: { title: string; tags: string[] }, fetchImpl: Fetch = fetch): Promise<'ok' | 'gone'> {
  const response = await call(settings, `/v1/notes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) }, fetchImpl)
  if (response.ok) return 'ok'
  if (response.status === 404) return 'gone'
  throw refused(response)
}

export interface PairStart { pairId: string; userCode: string; pollToken: string; verificationUrl: string; expiresIn: number; interval: number }
export type PairPoll = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token: string; deviceId: string; endpoint: string }

/** The server is reachable but not set up for one-tap connecting. */
export class PairingUnavailable extends ServerError {}

export async function startPairing(endpoint: string, deviceName: string, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<PairStart> {
  const response = await call({ endpoint, token: '' }, '/v1/pair/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName }), ...(signal ? { signal } : {}) }, fetchImpl)
  if (response.status === 501) throw new PairingUnavailable('This server is not set up for one-tap connecting.', 501)
  if (response.status === 429) throw new ServerError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Too many attempts. Try again in a few minutes.', 429)
  if (!response.ok) throw new ServerError(`The server answered ${response.status}.`, response.status)
  return (await response.json()) as PairStart
}

export async function pollPairing(endpoint: string, start: Pick<PairStart, 'pairId' | 'pollToken'>, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<PairPoll> {
  const response = await call({ endpoint, token: '' }, '/v1/pair/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }), ...(signal ? { signal } : {}) }, fetchImpl)
  if (!response.ok) throw new ServerError(`The server answered ${response.status}.`, response.status)
  return (await response.json()) as PairPoll
}

/** Cuts this device off on the server, so a lost phone cannot be used. Best effort: it is already forgotten locally. */
export async function disconnectThisDevice(settings: Credentials & Pick<Settings, 'deviceId'>, fetchImpl: Fetch = fetch): Promise<void> {
  if (!settings.deviceId || !settings.token) return
  try { await call(settings, `/v1/devices/${encodeURIComponent(settings.deviceId)}`, { method: 'DELETE' }, fetchImpl) } catch { /* the token is cleared locally either way */ }
}

export interface AccountInfo {
  /** Who this device belongs to. Null for a device connected the old way (with the server's own token). */
  account: { email: string; name: string } | null
  drive: { enabled: boolean; connected: boolean; canConnect: boolean }
}

/** Who this device is signed in as, and whether their Google Drive is connected. Null when the server cannot say. */
export async function fetchAccount(settings: Credentials, fetchImpl: Fetch = fetch): Promise<AccountInfo | null> {
  try {
    const [me, drive] = await Promise.all([call(settings, '/v1/me', {}, fetchImpl), call(settings, '/v1/drive', {}, fetchImpl)])
    if (!me.ok) return null
    const who = (await me.json()) as { account?: { email?: unknown; name?: unknown } | null }
    const state = drive.ok ? ((await drive.json()) as { enabled?: unknown; connected?: unknown; canConnect?: unknown }) : {}
    return {
      account: who.account && typeof who.account.email === 'string' ? { email: who.account.email, name: typeof who.account.name === 'string' ? who.account.name : who.account.email } : null,
      drive: { enabled: state.enabled === true, connected: state.connected === true, canConnect: state.canConnect === true },
    }
  } catch { return null }
}

export interface ServerNote {
  id: string
  /** The name to show: the person's own, else the assistant's rename, else the model's title. */
  title: string
  /** The name the person typed (here or on another device). Empty when they never named it. */
  userTitle: string
  /** Opens the note's folder in Google Drive, or null when it does not live there. */
  drive: string | null
}

/** The names and Drive links the server has for this person's notes. Null when it cannot say right now. */
export async function fetchServerNotes(settings: Credentials, fetchImpl: Fetch = fetch): Promise<ServerNote[] | null> {
  try {
    const response = await call(settings, '/v1/notes', {}, fetchImpl)
    if (!response.ok) return null
    const body = (await response.json()) as { notes?: unknown }
    if (!Array.isArray(body.notes)) return null
    return body.notes.flatMap((item): ServerNote[] => {
      const note = item as Partial<ServerNote> | null
      return note && typeof note.id === 'string' && typeof note.title === 'string'
        ? [{ id: note.id, title: note.title, userTitle: typeof note.userTitle === 'string' ? note.userTitle : '', drive: typeof note.drive === 'string' && note.drive.startsWith('https://') ? note.drive : null }]
        : []
    })
  } catch { return null }
}

export type TranscriptResult =
  | { status: 'ready'; text: string; language: string | null; durationSec: number | null; suspectedSilence: boolean; segments: Array<{ start: number; end: number; text: string }> }
  | { status: 'pending'; error: string | null }
  | { status: 'failed'; error: string | null }
  | { status: 'missing' }

/** A note's transcript: ready, still being written (or failed, with why), or not on the server. */
export async function fetchTranscript(settings: Credentials, id: string, fetchImpl: Fetch = fetch): Promise<TranscriptResult> {
  const response = await call(settings, `/v1/notes/${encodeURIComponent(id)}/transcript`, { method: 'GET' }, fetchImpl)
  if (response.status === 404) return { status: 'missing' }
  if (response.status !== 200 && response.status !== 202) throw refused(response)
  return (await response.json()) as TranscriptResult
}

// ---- the server's own options for this person (Settings > Storage > On your server) ----

export interface ServerPrefs {
  /** `keep`: the server keeps its working copy of the audio. `after-sorting`: it drops it once the note is sorted (Drive keeps the audio). */
  audioCache: 'keep' | 'after-sorting'
  /** The server's audio copies are trimmed (oldest first) past this many MB. 0 is no limit. */
  audioCacheMaxMb: number
  /** `trash`: a deleted note goes to Google Drive's trash (recoverable for about 30 days). `permanent`: gone for good. */
  deleteMode: 'trash' | 'permanent'
}

export interface ServerPreferences {
  /** False when this person's notes are not in Google Drive: then none of these options apply. */
  drive: boolean
  prefs: ServerPrefs
  defaults: ServerPrefs
  cache: { bytes: number; files: number } | null
}

const parsePrefs = (value: unknown): ServerPrefs | null => {
  const item = value as Partial<ServerPrefs> | null
  if (!item || (item.audioCache !== 'keep' && item.audioCache !== 'after-sorting') || (item.deleteMode !== 'trash' && item.deleteMode !== 'permanent')) return null
  if (typeof item.audioCacheMaxMb !== 'number' || !Number.isFinite(item.audioCacheMaxMb) || item.audioCacheMaxMb < 0) return null
  return { audioCache: item.audioCache, audioCacheMaxMb: item.audioCacheMaxMb, deleteMode: item.deleteMode }
}

async function readPreferences(response: Response): Promise<ServerPreferences> {
  const body = (await response.json()) as { drive?: unknown; prefs?: unknown; defaults?: unknown; cache?: { bytes?: unknown; files?: unknown } | null }
  const prefs = parsePrefs(body.prefs)
  const defaults = parsePrefs(body.defaults)
  if (!prefs || !defaults) throw new ServerError('The server sent options this app does not understand. Update the app or the server.', response.status)
  const cache = body.cache && typeof body.cache.bytes === 'number' && typeof body.cache.files === 'number' ? { bytes: body.cache.bytes, files: body.cache.files } : null
  return { drive: body.drive === true, prefs, defaults, cache }
}

/** The server's options for this person. Null when the server cannot say (an older server answers 404, or it is unreachable). */
export async function fetchPreferences(settings: Credentials, fetchImpl: Fetch = fetch): Promise<ServerPreferences | null> {
  try {
    const response = await call(settings, '/v1/preferences', {}, fetchImpl)
    return response.ok ? await readPreferences(response) : null
  } catch { return null }
}

/** Saves a change to the server's options and returns what the server now has. Throws a worded ServerError when it cannot. */
export async function savePreferences(settings: Credentials, patch: Partial<ServerPrefs>, fetchImpl: Fetch = fetch): Promise<ServerPreferences> {
  const response = await call(settings, '/v1/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }, fetchImpl)
  if (!response.ok) throw refused(response)
  return readPreferences(response)
}
