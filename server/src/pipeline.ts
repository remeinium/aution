import type { Brain } from './brain.ts'
import { digestNote, type DigestProgress } from './digest.ts'
import { transcribeBytes, type Fetch } from './stt.ts'
import type { Digest, NoteState } from './types.ts'
import { NoteGone, PermanentError, RateLimited, errorText, limitWaitMs, retryDelayMs } from './util.ts'

export interface PipelineOptions { fetch?: Fetch; retryDelay?: (attempts: number) => number; log?: (message: string) => void }

export interface PipelineStatus {
  notes: number
  waiting: number
  /** Written down and searchable, but not yet sorted into tasks and ideas by the assistant. */
  awaitingAssistant: number
  /** When sorting carries on after an AI service's usage limit (ISO time), or null when it is not waiting. */
  sortingPausedUntil: string | null
  failed: Array<{ id: string; stage: string | null; error: string | null }>
  needs: string[]
}

/** Moves each note through transcribe → digest → file. Every stage is saved to disk, so a restart picks up where it stopped. */
export class Pipeline {
  private readonly brain: Brain
  private readonly fetch: Fetch
  private readonly retryDelay: (attempts: number) => number
  private readonly log: (message: string) => void
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  /** While the AI service's usage limit holds, no note is sent to it (every note would just be refused). */
  private pausedUntil = 0
  /** How many limits in a row, for when the service does not say when it frees up. */
  private limitStreak = 0

  constructor(brain: Brain, options: PipelineOptions = {}) {
    this.brain = brain
    this.fetch = options.fetch ?? fetch
    this.retryDelay = options.retryDelay ?? (attempts => retryDelayMs(attempts))
    this.log = options.log ?? (message => console.log(message))
  }

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => this.kick(), this.brain.config.workerIntervalMs)
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    while (this.running) await this.running
  }

  /** Ask for a pass now. Passes never overlap; a request during a pass triggers one more afterwards. */
  kick(): void {
    if (this.stopped) return
    if (this.running) { this.again = true; return }
    this.running = this.pass().catch(error => this.log(`pipeline pass failed: ${errorText(error)}`)).finally(() => {
      this.running = null
      if (this.again) { this.again = false; this.kick() }
    })
  }

  /** Resolves when the current work, and anything requested while it ran, is done. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  async retry(id: string): Promise<boolean> {
    if (!(await this.brain.store.has(id))) return false
    await this.brain.store.writeState(id, { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null })
    this.kick()
    return true
  }

  async status(): Promise<PipelineStatus> {
    const { store, config, index } = this.brain
    const ids = await store.ids()
    const failed: PipelineStatus['failed'] = []
    let waiting = 0
    for (const id of ids) {
      const state = await store.state(id)
      if (state.failed) failed.push({ id, stage: state.stage, error: state.lastError })
      else if (!index.note(id) || (config.llm && !(await store.digest(id)))) waiting += 1
    }
    const needs: string[] = []
    if (!config.stt) needs.push('STT_BASE_URL (voice notes cannot be transcribed yet)')
    return { notes: ids.length, waiting, awaitingAssistant: index.waitingCount(), sortingPausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null, failed, needs }
  }

  private async pass(): Promise<void> {
    for (const id of await this.brain.store.ids()) {
      // Reading one note's state can fail on its own (a Drive call timing out); the rest of this person's notes still get their turn.
      try { await this.process(id) } catch (error) { this.log(`could not work on ${id.slice(0, 8)} this time: ${errorText(error)}`) }
    }
  }

  /** Applies the storage's retainAudio policy. Failing to evict a cache is not a reason to fail the note. */
  private async releaseAudio(id: string): Promise<void> {
    try { await this.brain.store.releaseAudio(id) } catch (error) {
      if (!(error instanceof NoteGone)) this.log(`could not release the local audio of ${id.slice(0, 8)}: ${errorText(error)}`)
    }
  }

  /** Saves the finished pieces of a long recording in the note's own folder, so a limit half way does not lose them. */
  private progressOf(id: string): DigestProgress {
    const { store } = this.brain
    return {
      load: async key => { const saved = await store.progress(id); return saved?.key === key && Array.isArray(saved.parts) ? (saved.parts as Awaited<ReturnType<DigestProgress['load']>>) : [] },
      save: (key, parts) => store.writeProgress(id, { key, parts }),
    }
  }

  /**
   * The AI service said its usage limit is reached. Nothing is lost and nothing is counted against the note: everything
   * done so far is saved, no other note is sent to the service until the limit should be over, and the note carries on by
   * itself then (also after a restart, because the time is saved with the note).
   */
  private async waitForLimit(id: string, state: NoteState, stage: NoteState['stage'], error: RateLimited): Promise<void> {
    this.limitStreak += 1
    const wait = limitWaitMs(error.retryAfterMs, this.limitStreak)
    const until = Date.now() + wait
    const first = this.pausedUntil < Date.now()
    this.pausedUntil = Math.max(this.pausedUntil, until)
    const minutes = Math.ceil(wait / 60_000)
    const how = minutes >= 120 ? `about ${Math.round(minutes / 60)} hours` : minutes >= 2 ? `about ${minutes} minutes` : 'a minute'
    if (first || until > this.pausedUntil - 1) this.log(`the AI service is at its usage limit; sorting waits ${how} and then carries on by itself (${errorText(error).slice(0, 160)})`)
    await this.brain.store.writeState(id, { attempts: state.attempts, nextAttemptAt: until, lastError: `Waiting for the AI service's usage limit to reset. Sorting carries on by itself in ${how}.`, failed: false, stage })
  }

  private async process(id: string): Promise<void> {
    const { store, config, index } = this.brain
    const state = await store.state(id)
    if (state.failed || (state.nextAttemptAt !== null && state.nextAttemptAt > Date.now())) return
    const meta = await store.meta(id)
    if (!meta) return
    let stage: NoteState['stage'] = null
    let worked = false
    try {
      let transcript = await store.transcript(id)
      if (!transcript) {
        if (!config.stt) return
        stage = 'transcribe'
        const audio = await store.audioBytes(meta)
        if (!audio) throw new PermanentError('This note has no audio and no text to work from.')
        transcript = await transcribeBytes(config.stt, audio, meta.audioFile ?? 'audio.webm', meta.mime, this.fetch)
        await store.writeTranscript(id, transcript)
        worked = true
        await this.brain.fileNote(id) // searchable straight away, even if the language model is down
        this.log(`transcribed ${id.slice(0, 8)} (${transcript.text.length} characters)`)
      }
      let digest = await store.digest(id)
      if (!digest) {
        // Sorting a note into tasks and ideas is the assistant's job (ChatGPT, through the MCP tools). With no model
        // configured here a note simply stays filed and searchable until it does. Silence needs no sorting.
        stage = 'digest'
        if (transcript.suspectedSilence) digest = silentDigest(meta.title)
        else if (config.llm && Date.now() >= this.pausedUntil) {
          digest = await digestNote(config.llm, meta, transcript, index.knownEntities(), this.fetch, this.progressOf(id))
          this.limitStreak = 0
        }
        if (digest) {
          await store.writeDigest(id, digest)
          worked = true
          this.log(`digested ${id.slice(0, 8)}: ${digest.tasks.length} task(s)`)
        }
      }
      stage = 'file'
      const row = index.note(id)
      if (!row || (digest && !row.digested)) await this.brain.fileNote(id)
      if (worked && digest) await this.releaseAudio(id) // transcribed and digested: the storage may now drop its local copy of the audio. Held until then, so the way back to the audio stays open.
      if (state.attempts || state.lastError) await store.writeState(id, { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null })
    } catch (error) {
      if (error instanceof NoteGone || !(await store.has(id))) return // deleted while we were working on it
      if (error instanceof RateLimited) { await this.waitForLimit(id, state, stage, error); return }
      const attempts = state.attempts + 1
      const permanent = error instanceof PermanentError || attempts >= config.maxAttempts
      this.log(`${stage ?? 'process'} failed for ${id.slice(0, 8)} (attempt ${attempts}${permanent ? ', giving up' : ''}): ${errorText(error)}`)
      await store.writeState(id, { attempts, nextAttemptAt: permanent ? null : Date.now() + this.retryDelay(attempts), lastError: errorText(error).slice(0, 500), failed: permanent, stage })
    }
  }
}

function silentDigest(title: string): Digest {
  return { title: title || 'No speech detected', summary: '', tasks: [], ideas: [], decisions: [], questions: [], people: [], projects: [], tags: [], droppedItems: 0, model: 'none', createdAt: new Date().toISOString() }
}
