// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Is there a newer Android app? Asks GitHub for the latest release of this project (at most every few hours, or right
 * away when the person taps "Check for updates") and compares its version with the one this app was built from. Only
 * the Android app checks: the website is always the newest version already.
 */
import { getKv, setKv } from '../lib/db'
import { APP_VERSION } from '../lib/types'

export interface Release { version: string; url: string; notesUrl: string }
export type UpdateCheck = { status: 'update'; release: Release } | { status: 'current' } | { status: 'error' }

const LATEST = 'https://api.github.com/repos/remeinium/aution/releases/latest'
const DOWNLOADS = 'https://github.com/remeinium/aution/releases/download/'
const CACHE_KEY = 'update-check'
const DISMISSED_KEY = 'update-dismissed'
const EVERY_MS = 6 * 60 * 60_000

/** `0.2.10` is newer than `0.2.9`; anything that is not three numbers is never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => (/^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null)
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number)
  return false
}

/** Picks the release's APK, from this repository's downloads only. */
export function releaseFrom(body: unknown): Release | null {
  const data = body as { tag_name?: unknown; html_url?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> }
  const version = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : ''
  const asset = (data.assets ?? []).find(item => item.name === 'aution.apk') ?? (data.assets ?? []).find(item => item.name === `aution-${version}.apk`)
  const url = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : ''
  if (!/^\d+\.\d+\.\d+$/.test(version) || !url.startsWith(DOWNLOADS)) return null
  return { version, url, notesUrl: typeof data.html_url === 'string' ? data.html_url : `https://github.com/remeinium/aution/releases/tag/v${version}` }
}

/**
 * Asks GitHub (or remembers the last answer for a few hours unless `force`). The answer says whether there is a newer
 * release, that this is the newest, or that it could not be told (offline, GitHub's rate limit). Never throws.
 */
export async function checkNow(options: { force?: boolean; now?: number; fetchImpl?: typeof fetch; current?: string } = {}): Promise<UpdateCheck> {
  const { force = false, now = Date.now(), fetchImpl = fetch, current = APP_VERSION } = options
  const cached = await getKv<{ at: number; release: Release | null }>(CACHE_KEY).catch(() => undefined)
  const verdict = (release: Release | null): UpdateCheck => (release && isNewer(release.version, current) ? { status: 'update', release } : { status: 'current' })
  if (!force && cached && now - cached.at < EVERY_MS) return verdict(cached.release)
  try {
    const response = await fetchImpl(LATEST, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return cached?.release && isNewer(cached.release.version, current) && !force ? verdict(cached.release) : { status: 'error' }
    const release = releaseFrom(await response.json())
    await setKv(CACHE_KEY, { at: now, release }).catch(() => undefined)
    return verdict(release)
  } catch {
    return { status: 'error' }
  }
}

/** The background check on startup: the newer release, or null. Errors count as "nothing new". */
export async function checkForUpdate(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Release | null> {
  const result = await checkNow({ now, fetchImpl })
  return result.status === 'update' ? result.release : null
}

/** "Not now" on the banner is remembered for that version only, so a newer release shows the banner again. */
export async function isDismissed(version: string): Promise<boolean> {
  return (await getKv<string>(DISMISSED_KEY).catch(() => undefined)) === version
}
export async function dismiss(version: string): Promise<void> { await setKv(DISMISSED_KEY, version).catch(() => undefined) }
