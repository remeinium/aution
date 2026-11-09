// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Xiaomi, Redmi and POCO phones only start a closed app for its background uploads when the app's "Autostart" switch
 * is on, and Android has no permission dialog for it. This banner explains that once, in one sentence, and opens the
 * screen with the switch. It hides itself when the switch is on, and everywhere except those phones.
 */
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { isAndroidApp } from './platform'

interface Check { autostartSwitch: boolean; autostart: boolean | null }

const background = <T,>(action: 'check' | 'open') => invoke<T>('plugin:aution-uploader|background', { action })

export function AutostartNotice() {
  const [needed, setNeeded] = useState(false)

  useEffect(() => {
    if (!isAndroidApp()) return
    // Checked again on return from the settings screen.
    const check = () => {
      if (document.visibilityState !== 'visible') return
      void background<Check>('check').then(result => setNeeded(result.autostartSwitch && result.autostart === false)).catch(() => setNeeded(false))
    }
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])

  if (!needed) return null
  return <div className="banner" role="status">
    <span>To upload while aution is closed, this phone needs its Autostart switch on.</span>
    <button type="button" className="secondary-button" onClick={() => { void background('open').catch(() => undefined) }}>Turn on Autostart</button>
  </div>
}
