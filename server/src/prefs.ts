import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkUser, type StoragePolicy } from './storage.ts'

/** What the server keeps of a person's audio besides Google Drive: `keep` it as a cache, or only until the note is sorted. */
export type AudioCache = 'keep' | 'after-sorting'
/** What deleting a note does in Drive: move it to Drive's trash (recoverable for about 30 days) or erase it. */
export type DeleteMode = 'trash' | 'permanent'
export interface Prefs { audioCache: AudioCache; audioCacheMaxMb: number; deleteMode: DeleteMode }

/** A request the person's app got wrong (a value out of range, a key that does not exist). The message is safe to show. */
export class PrefsError extends Error {}

const MAX_MB = 1_000_000
const AUDIO_CACHE: readonly string[] = ['keep', 'after-sorting']
const DELETE_MODE: readonly string[] = ['trash', 'permanent']

/** Checks one key's value. Returns it typed, or throws PrefsError. */
function check(key: string, value: unknown): Prefs[keyof Prefs] {
  if (key === 'audioCache' && typeof value === 'string' && AUDIO_CACHE.includes(value)) return value as AudioCache
  if (key === 'deleteMode' && typeof value === 'string' && DELETE_MODE.includes(value)) return value as DeleteMode
  if (key === 'audioCacheMaxMb' && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MB) return value
  if (key === 'audioCache' || key === 'deleteMode' || key === 'audioCacheMaxMb') throw new PrefsError(`${key} has a value this server does not accept.`)
  throw new PrefsError(`${key} is not a setting.`)
}

/**
 * Each person's choices about this server's copy of their audio and about deleting notes, kept next to the other
 * per-person files (devices.sqlite, drive.sqlite). Only what the person actually set is stored, so a later change of
 * the instance defaults still reaches everyone who never chose.
 */
export class UserPrefs {
  readonly defaults: Prefs
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, defaults: Prefs, now: () => number = Date.now) {
    this.defaults = { ...defaults }
    this.now = now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS prefs(user_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `)
  }

  close() { this.db.close() }

  /** What this person set, ignoring anything in the file that no longer passes the checks. */
  private stored(userId: string): Partial<Prefs> {
    const row = this.db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(checkUser(userId)) as { json: string } | undefined
    if (!row) return {}
    let parsed: unknown
    try { parsed = JSON.parse(row.json) } catch { return {} }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries((parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>)) {
      try { out[key] = check(key, value) } catch { /* a value from another version: fall back to the default */ }
    }
    return out as Partial<Prefs>
  }

  get(userId: string): Prefs { return { ...this.defaults, ...this.stored(userId) } }

  /** Applies a partial change. Unknown keys and bad values are refused as a whole, so a half-applied change never happens. */
  set(userId: string, patch: unknown): Prefs {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PrefsError('Send an object with the settings to change.')
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) clean[key] = check(key, value)
    const merged = { ...this.stored(userId), ...clean }
    this.db.prepare('INSERT INTO prefs(user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(userId, JSON.stringify(merged), this.now())
    return this.get(userId)
  }

  /** The same choices in the shape the storage layer wants. */
  policyFor(userId: string): StoragePolicy {
    const prefs = this.get(userId)
    return { retainAudio: prefs.audioCache === 'keep' ? 'keep' : 'drop-after-digest', maxCacheBytes: prefs.audioCacheMaxMb * 1024 * 1024, trashOnDelete: prefs.deleteMode === 'trash' }
  }
}
