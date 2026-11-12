// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One note's transcript, on its own screen (`#/transcript/<id>`), opened from "View transcript" in the Library. The
 * words come from the server (the app keeps only the audio); the recording plays from this device when it still has
 * it, and each timed passage jumps the player there. Back, here or the phone's own, returns to the Library.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, RotateCw } from 'lucide-react'
import { getAudio, getNote } from '../lib/db'
import { isSignedIn } from '../lib/endpoint'
import { errorMessage } from '../lib/errors'
import { clockTime, defaultTitle, formatClock, formatDuration } from '../lib/format'
import { useSettings, useToast } from '../lib/hooks'
import { fetchTranscript, type TranscriptResult } from '../lib/server'
import type { Note } from '../lib/types'

type View = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'result'; result: TranscriptResult }

/** `4:05` or `1:04:05`: where a passage starts. */
export function stamp(seconds: number): string {
  const clock = formatClock(seconds * 1000)
  return seconds >= 3600 ? clock.replace(/^0/, '') : clock.slice(3).replace(/^0(?=\d:)/, '')
}

/** While the server is still writing it down, look again this often. */
const POLL_MS = 15_000

export function goBackToLibrary() {
  // Opened from the Library, so going back returns there (and keeps its scroll); opened from a link, go there directly.
  if (window.history.length > 1) window.history.back()
  else window.location.hash = '#/library'
}

export function TranscriptPage({ id }: { id: string }) {
  const { settings } = useSettings()
  const toast = useToast()
  const [note, setNote] = useState<Note | null | undefined>(undefined)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'loading' })
  const player = useRef<HTMLAudioElement>(null)
  const signedIn = isSignedIn(settings)

  useEffect(() => { void getNote(id).then(found => setNote(found ?? null)) }, [id])

  useEffect(() => {
    if (!note || note.audioRemoved) return
    let url: string | null = null
    let cancelled = false
    void getAudio(note.id).then(blob => { if (blob && !cancelled) { url = URL.createObjectURL(blob); setAudioUrl(url) } })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [note])

  const load = useCallback(async () => {
    if (!signedIn) return
    try {
      setView({ kind: 'result', result: await fetchTranscript(settings, id) })
    } catch (error) {
      setView({ kind: 'error', message: errorMessage(error) })
    }
  }, [id, settings, signedIn])

  const uploaded = note?.status === 'uploaded'
  useEffect(() => { if (uploaded) void load() }, [uploaded, load])

  // Still being written down: look again until it is there.
  const pending = view.kind === 'result' && view.result.status === 'pending'
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(timer)
  }, [pending, load])

  const heading = note ? note.title || note.remoteTitle || defaultTitle(note.createdAt) : 'Transcript'
  const seek = (seconds: number) => { if (player.current) { player.current.currentTime = seconds; void player.current.play() } }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Transcript copied.') } catch { toast('Could not copy the transcript.') }
  }

  return <main className="page transcript-page">
    <div className="shell">
      <button type="button" className="text-link back-link" onClick={goBackToLibrary}><ArrowLeft size={14} aria-hidden="true" />Library</button>
      <p className="eyebrow">Transcript</p>
      <h1>{heading}</h1>
      {note && <p className="note-meta">{new Date(note.createdAt).toLocaleDateString()} · {clockTime(note.createdAt)} · {formatDuration(note.durationMs)}</p>}

      {note === null ? <p className="empty">This note is not on this device any more.</p> : <>
        {note && !note.audioRemoved && audioUrl && <audio ref={player} src={audioUrl} controls preload="metadata" aria-label={`Playback: ${heading}`} className="transcript-player" />}
        {note && <Body note={note} signedIn={signedIn} view={view} onRetry={() => { setView({ kind: 'loading' }); void load() }} onSeek={audioUrl ? seek : null} onCopy={copy} />}
      </>}
    </div>
  </main>
}

function Body({ note, signedIn, view, onRetry, onSeek, onCopy }: { note: Note; signedIn: boolean; view: View; onRetry: () => void; onSeek: ((seconds: number) => void) | null; onCopy: (text: string) => void }) {
  if (!signedIn) return <p className="hint">Sign in to see the transcript. It is written on your server after the note uploads.</p>
  if (note.status !== 'uploaded') return <p className="hint">The transcript is written on your server once this note has uploaded.</p>
  if (view.kind === 'loading') return <p className="hint">Loading the transcript…</p>
  if (view.kind === 'error') return <><p className="hint warn">Could not get the transcript. {view.message}</p><Retry onRetry={onRetry} /></>
  const result = view.result
  if (result.status === 'missing') return <p className="hint">Your server does not have this note any more. It may have been deleted everywhere from another device.</p>
  if (result.status === 'pending') return <><p className="hint">Being written down. Long recordings take a few minutes; this page checks again by itself.{result.error ? ` Last try: ${result.error}` : ''}</p><Retry onRetry={onRetry} /></>
  if (result.status === 'failed') return <><p className="hint warn">Your server could not write this note down. {result.error ?? ''}</p><Retry onRetry={onRetry} /></>
  if (!result.text.trim()) return <p className="hint">No words were heard in this recording.</p>

  const timed = result.segments.length > 0
  return <section className="transcript" aria-label="Transcript">
    {result.suspectedSilence && <p className="hint">This recording seems to be mostly silence, so these words may be invented by the transcriber.</p>}
    <div className="row-actions"><button type="button" className="secondary-button" onClick={() => onCopy(result.text)}><Copy size={14} aria-hidden="true" />Copy text</button></div>
    {timed
      ? <ol className="transcript-segments">
        {result.segments.map((segment, index) => <li key={`${segment.start}-${index}`}>
          {onSeek
            ? <button type="button" className="segment-time" onClick={() => onSeek(segment.start)} aria-label={`Play from ${stamp(segment.start)}`}>{stamp(segment.start)}</button>
            : <span className="segment-time">{stamp(segment.start)}</span>}
          <p>{segment.text.trim()}</p>
        </li>)}
      </ol>
      : <p className="transcript-text">{result.text}</p>}
  </section>
}

function Retry({ onRetry }: { onRetry: () => void }) {
  return <div className="row-actions"><button type="button" className="secondary-button" onClick={onRetry}><RotateCw size={14} aria-hidden="true" />Try again</button></div>
}
