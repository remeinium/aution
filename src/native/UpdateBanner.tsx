// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "aution 0.2.3 is available" with one Update button, in the Android app only. The app downloads the new APK itself
 * (progress in green), checks it is this app signed by its publisher, and opens Android's installer. The first time,
 * Android asks the person to allow installs from aution; after that, tapping Update again installs.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { isAndroidApp } from './platform'
import { checkForUpdate, type Release } from './update'

type Progress = { state: 'idle' } | { state: 'downloading'; percent: number } | { state: 'installing' } | { state: 'permission' } | { state: 'failed'; message: string }

export function UpdateBanner() {
  const [release, setRelease] = useState<Release | null>(null)
  const [progress, setProgress] = useState<Progress>({ state: 'idle' })
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (!isAndroidApp()) return
    const check = () => { if (document.visibilityState === 'visible') void checkForUpdate().then(setRelease) }
    check()
    document.addEventListener('visibilitychange', check)
    const listening = addPluginListener<Progress>('aution-uploader', 'update', event => setProgress(event))
    return () => { document.removeEventListener('visibilitychange', check); void listening.then(listener => listener.unregister()) }
  }, [])

  if (!release || hidden) return null
  const busy = progress.state === 'downloading'
  const update = () => {
    setProgress({ state: 'downloading', percent: 0 })
    void invoke('plugin:aution-uploader|update', { url: release.url, version: release.version }).catch(error => setProgress({ state: 'failed', message: String(error) }))
  }

  return <div className="shell"><div className="update-banner" role="status">
    <span>
      <strong>aution {release.version}</strong> is available.
      {progress.state === 'downloading' && <> Downloading <span className="status-percent">{progress.percent}%</span></>}
      {progress.state === 'installing' && ' Follow Android’s installer to finish.'}
      {progress.state === 'permission' && ' Allow aution to install apps on the screen that opened, then come back and tap Update again.'}
      {progress.state === 'failed' && ` The update did not download: ${progress.message}`}
    </span>
    <span className="update-actions">
      <button type="button" className="primary-button" onClick={update} disabled={busy}><Download size={14} aria-hidden="true" />{busy ? 'Downloading…' : 'Update'}</button>
      {!busy && <button type="button" className="text-link" onClick={() => setHidden(true)}>Not now</button>}
    </span>
  </div></div>
}
