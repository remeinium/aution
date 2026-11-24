import { useEffect, useState, type ReactNode } from 'react'
import { BRAND } from '../brand'
import { isAndroidApp, isNativeApp } from '../native/platform'
import { useNotes, useSettings, useToast } from '../lib/hooks'
import { isConfigured, isPrivateAddress, normalizeEndpoint } from '../lib/endpoint'
import { formatBytes } from '../lib/format'
import { errorMessage } from '../lib/errors'
import { retryFailed } from '../lib/notes'
import { KEEP_NEWEST, freeNow, getRetentionLog, planFreeNow, summarize, type RetentionRun } from '../lib/retention'
import { fetchPreferences, savePreferences, type ServerPreferences, type ServerPrefs } from '../lib/server'
import { kickUploads, pingServer } from '../lib/uploader'
import { APK_URL } from '../lib/defaults'
import { ChatGptCard } from '../components/ChatGptCard'
import { ConnectCard } from '../components/ConnectCard'
import { AutostartNotice } from '../native/AutostartNotice'
import { UpdateProgressText } from '../native/UpdateBanner'
import { checkNow, type UpdateCheck } from '../native/update'
import { useUpdater } from '../native/useUpdater'
import { APP_VERSION, type Settings } from '../lib/types'

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle">
    <span><span className="toggle-label">{label}</span>{hint && <span className="hint">{hint}</span>}</span>
    <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="toggle-track" aria-hidden="true"><span /></span>
  </label>
}

/** An option list where the chosen value is always present (an older or custom value is shown, not lost) and the default is marked. */
function Choice<T extends string | number>({ label, hint, value, options, defaultValue, format, onChange }: {
  label: string; hint?: ReactNode; value: T; options: Array<[T, string]>; defaultValue?: T; format?: (value: T) => string; onChange: (value: T) => void
}) {
  const all = options.some(([option]) => option === value) ? options : [...options, [value, format ? format(value) : `${value} (custom)`] as [T, string]]
  return <label className="field">
    <span className="field-label">{label}</span>
    <select value={String(value)} onChange={event => onChange((typeof value === 'number' ? Number(event.target.value) : event.target.value) as T)}>
      {all.map(([option, text]) => <option key={String(option)} value={String(option)}>{text}{option === defaultValue ? ' · default' : ''}</option>)}
    </select>
    {hint && <span className="hint">{hint}</span>}
  </label>
}

const KEEP_OPTIONS: Array<[number, string]> = [[-1, 'Keep forever'], [30, 'Remove after 30 days'], [7, 'Remove after 7 days'], [1, 'Remove after 1 day'], [0, 'Remove right away']]
const LIMIT_OPTIONS: Array<[number, string]> = [[0, 'No limit'], [250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB']]
const SERVER_LIMIT_OPTIONS: Array<[number, string]> = [[0, 'No limit'], [1000, '1 GB'], [5000, '5 GB'], [10000, '10 GB'], [20000, '20 GB']]
const ago = (at: number) => { const days = Math.floor((Date.now() - at) / 86_400_000); return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago` }

export function SettingsPage({ installPrompt }: { installPrompt: InstallEvent | null }) {
  const { settings, update } = useSettings()
  const { notes } = useNotes()
  const toast = useToast()
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState<string | null>(null)
  const endpoint = endpointDraft ?? settings.endpoint
  const token = tokenDraft ?? settings.token
  const [showToken, setShowToken] = useState(false)
  const [confirmingFree, setConfirmingFree] = useState(false)
  const [lastCleanup, setLastCleanup] = useState<RetentionRun | null>(null)
  const [server, setServer] = useState<ServerPreferences | null>(null)
  const [versionCheck, setVersionCheck] = useState<UpdateCheck | 'checking' | null>(null)
  const updater = useUpdater()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)

  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices().then(list => setDevices(list.filter(device => device.kind === 'audioinput'))).catch(() => undefined)
    void navigator.storage?.estimate().then(estimate => setStorage({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 })).catch(() => undefined)
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined)
  }, [notes.length])

  useEffect(() => { void getRetentionLog().then(log => setLastCleanup(log[0] ?? null)) }, [notes])
  const signedIn = isConfigured(settings) && Boolean(settings.token)
  useEffect(() => {
    if (!signedIn) return
    let alive = true
    void fetchPreferences({ endpoint: settings.endpoint, token: settings.token }).then(found => { if (alive) setServer(found) })
    return () => { alive = false }
  }, [signedIn, settings.endpoint, settings.token])
  const serverOptions = signedIn ? server : null

  const dirty = endpoint !== settings.endpoint || token !== settings.token
  const set = (patch: Partial<Settings>) => void update(patch)

  const saveConnection = async () => {
    await update({ endpoint, token })
    setEndpointDraft(null)
    setTokenDraft(null)
    const revived = await retryFailed()
    kickUploads({ force: false, ignoreBackoff: true })
    toast(revived ? `Saved. Retrying ${revived} ${revived === 1 ? 'note' : 'notes'}.` : 'Connection saved.')
  }

  const saveServer = async (patch: Partial<ServerPrefs>) => {
    try { setServer(await savePreferences(settings, patch)) } catch (error) { toast(`Not saved. ${errorMessage(error)}`) }
  }

  const checkForUpdates = async () => {
    setVersionCheck('checking')
    setVersionCheck(await checkNow({ force: true }))
  }

  const test = async () => {
    setTesting(true); setResult(null)
    setResult(await pingServer({ endpoint, token }))
    setTesting(false)
  }

  const waiting = notes.filter(note => note.status === 'local' || note.status === 'uploading').length
  const audioBytes = notes.filter(note => !note.audioRemoved).reduce((sum, note) => sum + note.size, 0)

  return <main className="page settings-page">
    <div className="shell narrow">
      <p className="eyebrow">This device</p>
      <h1>Settings</h1>

      <section className="settings-section" aria-labelledby="connection-title">
        <h2 id="connection-title">Connection</h2>
        <ConnectCard autoStart={new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('connect') === '1'} />
        <details className="advanced">
          <summary>Advanced: use an address and token by hand</summary>
          <p className="hint">For a server that cannot connect devices with one tap. You can also open a pairing link from the server.</p>
          <label className="field">
            <span className="field-label">Server address</span>
            <input value={endpoint} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://notes.example.com" onChange={event => { setEndpointDraft(event.target.value); setResult(null) }} />
          </label>
          <label className="field">
            <span className="field-label">Access token</span>
            <span className="input-row">
              <input value={token} type={showToken ? 'text' : 'password'} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => { setTokenDraft(event.target.value); setResult(null) }} />
              <button type="button" className="secondary-button" onClick={() => setShowToken(value => !value)} aria-pressed={showToken}>{showToken ? 'Hide' : 'Show'}</button>
            </span>
          </label>
          {endpoint && !token && <p className="hint warn">No token set. Anyone who finds this address could send notes to it.</p>}
          {endpoint && normalizeEndpoint(endpoint).startsWith('http://') && !isPrivateAddress(endpoint) && <p className="hint warn">This address is not encrypted. Use https:// for anything outside your own network.</p>}
          <label className="field">
            <span className="field-label">This device’s name</span>
            <input value={settings.deviceName} maxLength={40} onChange={event => set({ deviceName: event.target.value })} />
          </label>
          <div className="row-actions">
            <button type="button" className="primary-button" onClick={() => void saveConnection()} disabled={!dirty}>Save</button>
            <button type="button" className="secondary-button" onClick={() => void test()} disabled={testing || !endpoint}>{testing ? 'Testing…' : 'Test connection'}</button>
          </div>
          {result && <p className={`test-result ${result.ok ? 'ok' : 'bad'}`} role="status">{result.message}</p>}
        </details>
      </section>

      <section className="settings-section" aria-labelledby="upload-title">
        <h2 id="upload-title">Uploads</h2>
        <AutostartNotice />
        <Toggle label="Upload automatically" hint="Starts the moment a recording is saved, and again whenever the connection returns." checked={settings.autoUpload} onChange={value => { set({ autoUpload: value }); if (value) kickUploads({ ignoreBackoff: true }) }} />
        {isAndroidApp() && <Toggle label="Wi-Fi only" hint="Waiting notes are sent on Wi-Fi, never over mobile data." checked={settings.wifiOnly} onChange={value => { set({ wifiOnly: value }); kickUploads({ ignoreBackoff: true }) }} />}
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={() => { kickUploads({ force: true, ignoreBackoff: true }); toast(waiting ? `Uploading ${waiting} ${waiting === 1 ? 'note' : 'notes'}…` : 'Nothing is waiting.') }} disabled={!isConfigured(settings)}>Upload waiting notes now</button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="recording-title">
        <h2 id="recording-title">Recording</h2>
        <label className="field">
          <span className="field-label">Quality</span>
          <select value={settings.bitrate} onChange={event => set({ bitrate: Number(event.target.value) })}>
            <option value={24000}>Small · 24 kbps (about 11 MB an hour)</option>
            <option value={32000}>Speech · 32 kbps (about 14 MB an hour)</option>
            <option value={64000}>Clear · 64 kbps (about 29 MB an hour)</option>
            <option value={128000}>High · 128 kbps (about 58 MB an hour)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Microphone</span>
          <select value={settings.inputDeviceId} onChange={event => set({ inputDeviceId: event.target.value })}>
            <option value="">Default</option>
            {devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
          </select>
          {devices.length > 0 && devices.every(device => !device.label) && <span className="hint">Names appear after the first recording grants microphone access.</span>}
        </label>
        <Toggle label="Reduce background noise" checked={settings.noiseSuppression} onChange={value => set({ noiseSuppression: value })} />
        <Toggle label="Even out volume" hint="Automatic gain control." checked={settings.autoGainControl} onChange={value => set({ autoGainControl: value })} />
        <Toggle label="Cancel echo" hint="Helpful on speakerphone, can clip quiet speech." checked={settings.echoCancellation} onChange={value => set({ echoCancellation: value })} />
        <Toggle label="Start recording when the app opens" hint="The Record shortcut on your home screen always does this." checked={settings.recordOnOpen} onChange={value => set({ recordOnOpen: value })} />
      </section>

      <section className="settings-section" aria-labelledby="storage-title">
        <h2 id="storage-title">Storage</h2>
        <p className="hint">Nothing is removed unless you choose it here. Audio only leaves this device after your server has it, and a note always stays in your Library.</p>
        <dl className="facts">
          <div><dt>Notes on this device</dt><dd>{notes.filter(note => note.status !== 'recording').length}</dd></div>
          <div><dt>Waiting to upload</dt><dd>{waiting}</dd></div>
          <div><dt>Audio stored</dt><dd>{formatBytes(audioBytes)}</dd></div>
          {storage && storage.quota > 0 && <div><dt>Browser storage used</dt><dd>{formatBytes(storage.usage)} of {formatBytes(storage.quota)}</dd></div>}
        </dl>

        <h3 className="settings-subhead">On this device</h3>
        <Choice label="Audio after it has uploaded" value={settings.keepAfterUpload} options={KEEP_OPTIONS} defaultValue={-1} format={days => `Remove after ${days} days`} onChange={value => set({ keepAfterUpload: value })} />
        <Choice label="Limit the audio kept on this device" value={settings.storageLimitMb} options={LIMIT_OPTIONS} defaultValue={0} format={mb => `${mb} MB (custom)`} onChange={value => set({ storageLimitMb: value })}
          hint={settings.storageLimitMb > 0 ? `When it adds up to more than this, the oldest recordings go first. The newest ${KEEP_NEWEST} always keep their audio.` : undefined} />
        {(() => {
          const free = summarize(planFreeNow(notes))
          return <>
            <div className="row-actions">
              <button type="button" className="secondary-button" disabled={free.count === 0}
                onClick={() => { setConfirmingFree(value => !value) }}>
                {free.count === 0 ? 'Nothing to free up' : 'Free up space now…'}
              </button>
            </div>
            {confirmingFree && free.count > 0 && <div role="group" aria-label="Free up space">
              <p className="hint">This removes the audio of {free.count} {free.count === 1 ? 'recording' : 'recordings'} ({formatBytes(free.bytes)}) from this device. They stay in your Library and on your server.</p>
              <div className="row-actions">
                <button type="button" className="secondary-button danger" onClick={async () => {
                  setConfirmingFree(false)
                  const done = await freeNow()
                  toast(`Freed ${formatBytes(done.bytes)} from ${done.count} ${done.count === 1 ? 'recording' : 'recordings'}. Your server still has them.`)
                }}>Remove {formatBytes(free.bytes)}</button>
                <button type="button" className="secondary-button" onClick={() => setConfirmingFree(false)}>Cancel</button>
              </div>
            </div>}
          </>
        })()}
        {lastCleanup && <p className="hint">Last cleanup {ago(lastCleanup.at)}: audio of {lastCleanup.count} {lastCleanup.count === 1 ? 'recording' : 'recordings'} ({formatBytes(lastCleanup.bytes)}) was removed from this device.</p>}
        {persisted === false && <>
          <p className="hint">The browser may clear this device’s data when space is low. Ask it to keep your notes until they are uploaded.</p>
          <div className="row-actions"><button type="button" className="secondary-button" onClick={async () => { const granted = await navigator.storage.persist(); setPersisted(granted); toast(granted ? 'Storage will be kept.' : 'The browser declined. Installing the app usually helps.') }}>Keep my data</button></div>
        </>}
        {persisted === true && <p className="hint">Storage is protected from automatic clearing.</p>}

        {serverOptions?.drive && <>
          <h3 className="settings-subhead">On your server</h3>
          <p className="hint">Your recordings and transcripts live in your Google Drive. The server only keeps a working copy of the audio, and fetches it back from Drive whenever it needs it.</p>
          <Choice label="The server’s copy of the audio" value={serverOptions.prefs.audioCache} defaultValue={serverOptions.defaults.audioCache}
            options={[['keep', 'Keep it'], ['after-sorting', 'Remove it once the note is sorted']]} onChange={value => void saveServer({ audioCache: value })} />
          <Choice label="Limit the server’s audio copies" value={serverOptions.prefs.audioCacheMaxMb} options={SERVER_LIMIT_OPTIONS} defaultValue={serverOptions.defaults.audioCacheMaxMb} format={mb => `${mb} MB (custom)`} onChange={value => void saveServer({ audioCacheMaxMb: value })}
            hint={`${serverOptions.cache ? `Using ${formatBytes(serverOptions.cache.bytes)} now. ` : ''}Past the limit the oldest copies go first, and only ones Google Drive has confirmed.`} />
          <Choice label="When I delete a note" value={serverOptions.prefs.deleteMode} defaultValue={serverOptions.defaults.deleteMode}
            options={[['trash', 'Move it to Google Drive’s trash'], ['permanent', 'Delete it permanently']]} onChange={value => void saveServer({ deleteMode: value })}
            hint={serverOptions.prefs.deleteMode === 'trash' ? 'You can restore it from your Drive trash for about 30 days. Until Drive empties the trash it still counts against your Drive space.' : 'It is removed from Google Drive straight away and cannot be restored.'} />
        </>}
      </section>

      <section className="settings-section" aria-labelledby="chatgpt-title">
        <h2 id="chatgpt-title">ChatGPT</h2>
        <ChatGptCard />
      </section>

      {/* The native app is already installed: the PWA install help does not apply there. */}
      {!isNativeApp() && <section className="settings-section" aria-labelledby="install-title">
        <h2 id="install-title">Install</h2>
        {window.matchMedia('(display-mode: standalone)').matches
          ? <p className="hint">Installed. Press and hold the app icon for the Record shortcut.</p>
          : installPrompt
            ? <><p className="hint">Add {BRAND.name} to your home screen to open it like an app, offline, with a one-tap Record shortcut.</p>
              <div className="row-actions"><button type="button" className="primary-button" onClick={() => void installPrompt.prompt()}>Install app</button></div></>
            : <p className="hint">In your browser menu choose “Install app” or “Add to Home screen”. On iPhone use Share, then Add to Home Screen.</p>}
      </section>}

      {!isNativeApp() && APK_URL && <section className="settings-section" aria-labelledby="android-title">
        <h2 id="android-title">Android app</h2>
        <p className="hint">Keeps recording with the screen off and uploads in the background. Open this page on the Android phone, download, then open the file to install.</p>
        <div className="row-actions"><a className="secondary-button" href={APK_URL} rel="noopener">Download the Android app</a></div>
      </section>}

      <section className="settings-section" aria-labelledby="about-title">
        <h2 id="about-title">About</h2>
        <dl className="facts">
          <div><dt>Version</dt><dd>{APP_VERSION}</dd></div>
        </dl>
        {isAndroidApp()
          ? <>
            <div className="row-actions">
              <button type="button" className="secondary-button" onClick={() => void checkForUpdates()} disabled={versionCheck === 'checking' || updater.busy}>{versionCheck === 'checking' ? 'Checking…' : 'Check for updates'}</button>
              {typeof versionCheck === 'object' && versionCheck?.status === 'update' && <button type="button" className="primary-button" onClick={() => updater.start(versionCheck.release)} disabled={updater.busy}>{updater.busy ? 'Downloading…' : `Update to ${versionCheck.release.version}`}</button>}
            </div>
            <p className="hint" role="status">
              {typeof versionCheck === 'object' && versionCheck?.status === 'current' && 'You have the newest version.'}
              {typeof versionCheck === 'object' && versionCheck?.status === 'update' && <>aution {versionCheck.release.version} is available. <UpdateProgressText progress={updater.progress} /></>}
              {typeof versionCheck === 'object' && versionCheck?.status === 'error' && 'Could not check right now. Check your connection and try again.'}
              {versionCheck === null && 'The app also checks quietly by itself when it opens.'}
            </p>
          </>
          : <p className="hint">The website always runs the newest version: close and reopen it to pick up a new release.</p>}
      </section>

      <section className="settings-section" aria-labelledby="help-title">
        <h2 id="help-title">Help</h2>
        <p className="hint">Step by step, with pictures: signing in, recording, Google Drive and ChatGPT.</p>
        <div className="row-actions"><a className="secondary-button" href="#/guide">Open the user guide</a></div>
      </section>
    </div>
  </main>
}
