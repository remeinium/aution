// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The update itself, shared by the banner and Settings: asks the Android app to download the release's APK (checked
 * to be this app, signed by its publisher) and open Android's installer. Progress arrives as events from the plugin.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'
import { isAndroidApp } from './platform'
import type { Release } from './update'

export type UpdateProgress = { state: 'idle' } | { state: 'downloading'; percent: number } | { state: 'installing' } | { state: 'permission' } | { state: 'failed'; message: string }

export function useUpdater(): { progress: UpdateProgress; busy: boolean; start: (release: Release) => void } {
  const [progress, setProgress] = useState<UpdateProgress>({ state: 'idle' })

  useEffect(() => {
    if (!isAndroidApp()) return
    const listening = addPluginListener<UpdateProgress>('aution-uploader', 'update', event => setProgress(event))
    return () => { void listening.then(listener => listener.unregister()) }
  }, [])

  const start = useCallback((release: Release) => {
    setProgress({ state: 'downloading', percent: 0 })
    void invoke('plugin:aution-uploader|update', { url: release.url, version: release.version }).catch(error => setProgress({ state: 'failed', message: String(error) }))
  }, [])

  return { progress, busy: progress.state === 'downloading', start }
}
