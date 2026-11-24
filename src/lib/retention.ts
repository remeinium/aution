/**
 * Every automatic removal of audio from this device goes through here: one policy (Settings > Storage), one planner
 * that decides, one executor that acts. Nothing is removed unless the person chose a rule, and never a recording the
 * server does not have: that audio would be the only copy.
 *
 * The notes themselves are never touched. Only the audio file on this device goes; the note stays in the Library and
 * its audio stays on the server (and in the person's Google Drive).
 */
import { notifyChanged } from './changes'
import { getKv, getNote, listNotes, removeAudio, setKv, updateNote } from './db'
import { loadSettings } from './settings'
import type { Note } from './types'

/** The newest notes always keep their audio when the size limit frees space. A safety rule, not an option. */
export const KEEP_NEWEST = 5

const DAY_MS = 86_400_000
const MB = 1024 * 1024

export interface RetentionPolicy {
  /** Days audio stays after upload: -1 forever, 0 right away. */
  keepAfterUploadDays: number
  /** Free the oldest audio past this many MB. 0 is off. */
  limitMb: number
  keepNewest: number
}

export type Reason = 'after-upload' | 'age' | 'limit' | 'manual'
export interface Removal { id: string; bytes: number; reason: Reason }

/** THE invariant. A note whose upload the server confirmed, with audio still here. Nothing else may ever be removed. */
export const isSafeToRemove = (note: Note): boolean => note.status === 'uploaded' && note.uploadedAt !== null && !note.audioRemoved

const newestFirst = (a: Note, b: Note) => b.createdAt - a.createdAt
const oldestFirst = (a: Note, b: Note) => a.createdAt - b.createdAt

/**
 * What the policy would remove right now. Pure: no I/O, so it is also what previews and tests call.
 * First the age rule (every safe note older than the chosen days; 0 means all of them), then the size rule on what is
 * left: oldest first, never the newest `keepNewest` notes, until the audio on the device fits the limit.
 */
export function planRetention(notes: Note[], policy: RetentionPolicy, now: number): Removal[] {
  const chosen = new Map<string, Removal>()
  const safe = notes.filter(isSafeToRemove)

  const days = policy.keepAfterUploadDays
  if (days >= 0) {
    for (const note of safe) {
      if (days === 0 || now - (note.uploadedAt as number) >= days * DAY_MS) chosen.set(note.id, { id: note.id, bytes: note.size, reason: days === 0 ? 'after-upload' : 'age' })
    }
  }

  if (policy.limitMb > 0) {
    const limit = policy.limitMb * MB
    const saved = notes.filter(note => note.status !== 'recording')
    let total = saved.filter(note => !note.audioRemoved && !chosen.has(note.id)).reduce((sum, note) => sum + note.size, 0)
    if (total > limit) {
      const protectedIds = new Set([...saved].sort(newestFirst).slice(0, policy.keepNewest).map(note => note.id))
      for (const note of safe.filter(item => !chosen.has(item.id) && !protectedIds.has(item.id)).sort(oldestFirst)) {
        if (total <= limit) break
        chosen.set(note.id, { id: note.id, bytes: note.size, reason: 'limit' })
        total -= note.size
      }
    }
  }
  return [...chosen.values()]
}

/** Everything already safe on the server: the "Free up space now" button. */
export function planFreeNow(notes: Note[]): Removal[] {
  return notes.filter(isSafeToRemove).sort(oldestFirst).map(note => ({ id: note.id, bytes: note.size, reason: 'manual' as const }))
}

export const summarize = (plan: Removal[]): { count: number; bytes: number } => ({ count: plan.length, bytes: plan.reduce((sum, item) => sum + item.bytes, 0) })

// ---- the log: what was removed and why, so "where did my audio go?" has an answer ----

export interface RetentionRun { at: number; count: number; bytes: number; reasons: Reason[] }
const LOG_KEY = 'retention-log'
const LOG_RUNS = 20

export async function getRetentionLog(): Promise<RetentionRun[]> {
  const stored = await getKv<RetentionRun[]>(LOG_KEY).catch(() => undefined)
  return Array.isArray(stored) ? stored : []
}

async function record(run: RetentionRun): Promise<void> {
  await setKv(LOG_KEY, [run, ...(await getRetentionLog())].slice(0, LOG_RUNS)).catch(() => undefined)
}

// ---- the executor ----

/** Removes the audio of each planned note, checking the invariant again at the moment of removal. */
async function execute(plan: Removal[], now: number): Promise<{ count: number; bytes: number }> {
  const done: Removal[] = []
  for (const item of plan) {
    const note = await getNote(item.id)
    if (!note || !isSafeToRemove(note)) continue
    await removeAudio(item.id)
    await updateNote(item.id, { audioRemoved: true })
    done.push(item)
  }
  const result = summarize(done)
  if (result.count) {
    await record({ at: now, count: result.count, bytes: result.bytes, reasons: [...new Set(done.map(item => item.reason))] })
    notifyChanged()
  }
  return result
}

let running: Promise<number> | null = null
let again = false

/**
 * Applies the person's rules. Safe to call as often as you like: overlapping calls coalesce into one more pass right
 * after the current one (so an upload that finishes mid-run is still handled). Never throws, because it runs inside
 * the upload path. Returns how many notes lost their audio.
 */
export function applyRetention(): Promise<number> {
  if (running) { again = true; return running }
  running = (async () => {
    let total = 0
    do {
      again = false
      try {
        const settings = await loadSettings()
        const plan = planRetention(await listNotes(), { keepAfterUploadDays: settings.keepAfterUpload, limitMb: settings.storageLimitMb, keepNewest: KEEP_NEWEST }, Date.now())
        if (plan.length) total += (await execute(plan, Date.now())).count
      } catch { /* a failed cleanup is retried on the next change; it must never break an upload */ }
    } while (again)
    return total
  })().finally(() => { running = null })
  return running
}

/** The "Free up space now" action: all audio that is already safe on the server, as the person asked. */
export async function freeNow(): Promise<{ count: number; bytes: number }> {
  return execute(planFreeNow(await listNotes()), Date.now())
}
