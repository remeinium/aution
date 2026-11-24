// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "aution 0.2.3 is available" with one Update button, in the Android app only. The check runs by itself in the
 * background at startup (and when the app comes back to the front); the banner appears only when there is something
 * newer. "Not now" hides it for that version (it comes back for a newer one), and Settings can check on demand.
 * The app downloads the new APK itself (progress in green), checks it is this app signed by its publisher, and opens
 * Android's installer. The first time, Android asks the person to allow installs from aution.
 */
import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { isAndroidApp } from './platform'
import { checkForUpdate, dismiss, isDismissed, type Release } from './update'
import { useUpdater, type UpdateProgress } from './useUpdater'

/** What the update is doing, in words (also used by Settings). */
export function UpdateProgressText({ progress }: { progress: UpdateProgress }) {
  return <>
    {progress.state === 'downloading' && <> Downloading <span className="status-percent">{progress.percent}%</span></>}
    {progress.state === 'installing' && ' Follow Android’s installer to finish.'}
    {progress.state === 'permission' && ' Allow aution to install apps on the screen that opened, then come back and tap Update again.'}
    {progress.state === 'failed' && ` The update did not download: ${progress.message}`}
  </>
}

export function UpdateBanner() {
  const [release, setRelease] = useState<Release | null>(null)
  const [hidden, setHidden] = useState(false)
  const { progress, busy, start } = useUpdater()

  useEffect(() => {
    if (!isAndroidApp()) return
    let alive = true
    const check = () => {
      if (document.visibilityState !== 'visible') return
      void checkForUpdate().then(async found => { if (alive && found && !(await isDismissed(found.version))) setRelease(found) })
    }
    check()
    document.addEventListener('visibilitychange', check)
    return () => { alive = false; document.removeEventListener('visibilitychange', check) }
  }, [])

  if (!release || hidden) return null
  const notNow = () => { setHidden(true); void dismiss(release.version) }

  return <div className="shell"><div className="update-banner" role="status">
    <span>
      <strong>aution {release.version}</strong> is available.
      <UpdateProgressText progress={progress} />
    </span>
    <span className="update-actions">
      <button type="button" className="primary-button" onClick={() => start(release)} disabled={busy}><Download size={14} aria-hidden="true" />{busy ? 'Downloading…' : 'Update'}</button>
      {!busy && <button type="button" className="text-link" onClick={notNow}>Not now</button>}
    </span>
  </div></div>
}
