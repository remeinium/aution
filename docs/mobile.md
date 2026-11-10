# aution for Android (Tauri 2)

The native app wraps the same React UI as the website and adds what a browser cannot do: recording with the screen
off, uploading in the background (also after a reboot), and keeping the device token in the Android Keystore.
iOS comes later (see the end).

> **Status: in progress.** Each phase below says what has been checked **on a real phone**. Anything not run on a
> phone is marked *untested*.

> ⚠️ **The application id `com.remeinium.aution` becomes permanent the moment an APK reaches a real user.** Android
> treats a different id as a different app, so changing it later breaks updates for everyone. It is set in
> `src/brand.ts` and `src-tauri/tauri.conf.json` (`tests/brand.test.ts` fails if they disagree). Confirm it before
> the first release.

## Name and identity, in one place

| What | Where |
|---|---|
| Display name `aution`, tagline, app id, website `https://aution.remeinium.com` | `src/brand.ts` |
| `productName`, `identifier`, window title | `src-tauri/tauri.conf.json` (checked against `brand.ts` by a test) |
| Page title, description, web manifest name | filled from `brand.ts` at build time (`vite.config.ts`) |

Deliberately unchanged: the IndexedDB database `trapper-voice` (renaming it would strand the notes already on
phones), the upload protocol's `app` field, and the server's own name and its ChatGPT plugin name.

## How the app is put together

```
React UI (unchanged)
  └─ src/lib/{recorder,uploader,settings}.ts   same exports as before
       └─ src/native/        the seams: Recorder, Uploader, SecureStore, Platform
            ├─ web.ts        browser: MediaRecorder, IndexedDB, service worker   (the website)
            └─ tauri.ts      native: Kotlin plugin, WorkManager, Keystore        (the Android app)
```

`src/native/runtime.ts` picks the implementation once at startup. A part that is not native yet falls back to the
web code, which also runs inside the app's WebView while the screen is on.

Differences inside the app that need no UI change:
- **No service worker.** Tauri serves the app from `https://tauri.localhost` through the WebView's
  `shouldInterceptRequest` (wry 0.57, `RustWebViewClient.kt`); a service worker's requests do not pass through
  there, so `sw.js` is not registered in the app. Background upload is native instead.
- **External pages open in the system browser.** Android's WebView does not open new windows, so every
  `target="_blank"` link and `window.open` goes to the browser through the opener plugin
  (`src/native/links.ts`). Only `https://` addresses are allowed (`src-tauri/capabilities/default.json`).
- **No install prompt** in Settings.
- **https only.** The release CSP allows `connect-src https:` only; `devCsp` adds localhost for development.
  `useHttpsScheme` is on, so the app's origin is `https://tauri.localhost`. Do not change that setting after the
  first release: the WebView would lose the app's IndexedDB (and every unsent note in it).

## Claims checked against the source

| Claim | Checked how | Result |
|---|---|---|
| A WebView needs native help to grant the microphone | wry 0.57.1 `RustWebChromeClient.onPermissionRequest` | Already handled by wry: it asks for `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` at runtime, if both are in the manifest |
| Service workers do not work in the app | wry serves the app via `shouldInterceptRequest`, no `ServiceWorkerController` | True in practice; the app does not register one |
| Android pauses a backgrounded WebView | Tauri 2.12 config schema, `backgroundThrottling`: "Linux / Windows / Android: Unsupported" | True: the WebView cannot opt out |
| WebView microphone stops when the screen turns off | Phone test: screen off for 20 s while recording, read `AudioRecordImpl` stats in logcat | True, and worse than stopping: the recording carries on but Android hands it silence (`[mute]`), so the note looks fine and is empty for that stretch |
| Android 14 needs a `microphone` foreground service | Android docs (foreground service types, Android 14) and the merged manifest of the APK (`aapt2 dump xmltree`) | True: `RecorderService` is declared with `foregroundServiceType=microphone` (0x80) and the app holds `FOREGROUND_SERVICE_MICROPHONE`; Android logged `Background started FGS: Allowed` when the recording started |
| Raw bytes can be sent from the page to native code (`invoke(cmd, Uint8Array)`) | Phone test, and Tauri 2.12 `scripts/ipc-protocol.js`: `canUseCustomProtocol = osName !== 'android'` | False on Android: the IPC from the page is `postMessage` with JSON text, so a raw body arrives as JSON, not bytes. Audio goes to the outbox by moving the native recording's file, or in base64 pieces of 256 KB. (Native → page binary *responses* do work: `read_recording`.) |
| A closed app's WorkManager job runs when the network returns | Phone test with the app swiped away | Not on Xiaomi with Autostart off: the job was due, and HyperOS refused to start the app (`Unable to launch app … process is bad`, app-op `MIUIOP(10008): ignore`). With Autostart on, Android started the app in the background and the job uploaded |
| A Tauri plugin's events need a permission | Phone test: `addPluginListener` failed with `aution-recorder.registerListener not allowed` | True: `register_listener` and `remove_listener` must be in the plugin's `COMMANDS` and its default permission, or the UI never hears the plugin's events |

## Libraries added, and their licences

All must be compatible with AGPL-3.0.

| Library | Used for | Licence |
|---|---|---|
| `@tauri-apps/api` 2.12 (npm) | calling native code from the UI | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-opener` 2.7 (npm) + `tauri-plugin-opener` 2.7 (crate) | opening pages in the system browser | Apache-2.0 OR MIT |
| `tauri-plugin-aution-recorder` (this repo, `src-tauri/plugins/aution-recorder`) | the native recorder | AGPL-3.0-only (ours) |
| `serde` 1, `thiserror` 2 (crates) | the recorder plugin's Rust side | MIT OR Apache-2.0 |
| `androidx.core:core-ktx` 1.17, `androidx.appcompat:appcompat` 1.7 | notifications, foreground service helpers | Apache-2.0 |
| `androidx.work:work-runtime` 2.12 (brings `androidx.room`, `androidx.startup`, `kotlinx-coroutines`) | background uploads, rescheduled after a reboot | Apache-2.0 |
| `tauri-plugin-aution-uploader` (this repo, `src-tauri/plugins/aution-uploader`) | the native uploader and the Keystore token store | AGPL-3.0-only (ours) |

Build tools (not shipped in the APK): Amazon Corretto 21 (GPLv2 with Classpath Exception), Android SDK
command-line tools and NDK (Android SDK licence).

## Needs from the server

Status after the rename to aution (the server changes are on the same branch as this note):

1. **CORS for the app's origin: nothing to do while `ALLOWED_ORIGIN=*`.** Requests from inside the app come from
   origin `https://tauri.localhost`. The API uses bearer tokens, not cookies, so `*` is safe for `/v1`. If production
   ever restricts `ALLOWED_ORIGIN`, `https://tauri.localhost` must be allowed (the setting takes one value today, so
   it would need to become a list).
2. **Brand on the server's pages: done.** The product has one name, aution, everywhere a person reads it (approval,
   sign-out and account pages, MCP name, error messages). It is written directly, not read from a setting.
3. **Switching Google accounts from the approval page: done.** `/pair` shows "Not you? Use a different account" for
   a signed-in person. It posts to `/pair/switch` (same-origin only), which ends the session and restarts Google
   sign-in at the account chooser.

## Build it locally

Toolchain (what this was built with): JDK 21 (Corretto, in `~/.local/jdk`), Android SDK in `~/Android/Sdk` with
platform 37, build-tools 37.0.0 and NDK 30.0.16248370, Rust with the targets `aarch64-linux-android` and
`armv7-linux-androideabi`, Node 24. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` (the NDK folder).

- **Debug APK** for testing (277 MB, debug symbols, id `com.remeinium.aution.debug`, so it installs next to the real
  app): `npx tauri android build --debug --apk --target aarch64`, then
  `adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
- **Release APK** (signed, 12.7 MB for 0.2.0): `npm run android:release` writes `artifacts/android/aution-<version>.apk`
  and `artifacts/android/aution.apk`, and prints the signing certificate's SHA-256 so you can check it.

## Release

**Signing.** The key is `~/.config/aution/release.jks` (alias `aution`, RSA 4096, valid until 2054), its password in
`~/.config/aution/release.properties`, both readable only by the owner and **outside the repository**. Certificate
SHA-256: `42:F2:95:BB:AE:D4:04:FE:37:68:41:FE:77:61:B4:55:20:B3:32:0C:F4:B1:2D:C3:8B:D6:37:EC:10:B6:C4:F0`.
A copy is in **Doppler** (project `aution`, config `prd`: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_CERT_SHA256`), so on another machine `doppler run -p aution -c prd -- npm run android:release`
builds a signed APK with no key file on disk. **Keep a second backup outside Doppler too** (a password manager, an encrypted drive): every future update must be signed
with this key, or installed phones refuse it and people must uninstall (losing unsent notes) to get the new version.

Gradle reads the key from the environment (`src-tauri/gen/android/app/build.gradle.kts`), never from the repo:
`AUTION_SIGNING_PROPERTIES=/path/to/release.properties`, or `AUTION_KEYSTORE_FILE` + `AUTION_KEYSTORE_PASSWORD`
(+ `AUTION_KEY_ALIAS`, `AUTION_KEY_PASSWORD`). The release script refuses to build without a key, so an unsigned APK
is never published by mistake.

**versionCode.** Tauri derives it from the version in `package.json`: `major × 1,000,000 + minor × 1,000 + patch`
(0.2.0 → 2000, 1.4.12 → 1004012). Android only installs an update with a higher versionCode, so every release needs a
higher version; never reuse or lower one. Patch and minor stay below 1000.

**Publishing.** Raise `version` in `package.json`, commit, then tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
`.github/workflows/android.yml` checks that the tag matches `package.json`, runs the unit tests, builds the signed APK
and attaches `aution.apk` (plus `aution-<version>.apk`) to the GitHub release of that tag. It needs the repository
secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. "Run workflow" by hand builds the APK as an artifact
without a release.

**Download link.** The website's Settings shows "Download the Android app" (hidden inside the app), pointing to
`https://github.com/remeinium/aution/releases/latest/download/aution.apk`, which is always the newest release. Set
`VITE_APK_URL` when building the website to point elsewhere, or to an empty value to hide it. Installing needs
"Install unknown apps" allowed for the browser or Files app; Android asks the first time.

## Checklist on a real phone

Filled in on a real phone.

| Check | Result | Date, phone, Android version |
|---|---|---|
| Signed release APK: install from Files, open, connect, record, upload | works (0.2.0, 12.7 MB) | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| App starts, shows the UI | works: cold start 1.04 s, no console or CSP errors | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Microphone permission prompt, then recording works (screen on) | works: system prompt "Allow aution to record audio?", 57 s note saved (188 KB); level meter responds (peak 0.06 quiet, 0.26 speaking) | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Pairing with one tap, then upload (screen on) | works: approval page opened in the system browser, Google sign-in, note shows "Uploaded" | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Screen off while recording (native recorder) | works: 81 s note with the screen off from 0:16 to 1:17; loudness of the audio itself stays at -22 to -28 dB RMS throughout (silence would be below -60 dB). 5 minutes not run yet | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| 5 minute recording with the screen off | **fails with the web recorder** (as expected): with the screen off Android feeds the WebView silence (AudioRecord stats switch from `fine` to `mute`, 12 s muted in a 20 s test). Fixed by the native recorder in phase 2 | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Switching to other apps while recording | works (owner's test): recording carried on behind another app and was stopped from the notification; the note appeared when aution was opened | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Incoming phone call while recording | untested | |
| Airplane mode, then back online: queued notes upload | works, **with the app swiped away** (needs Xiaomi's Autostart on, see phase 3): network back at 01:13:33, Android started aution in the background, uploaded at 01:13:47 (second try, 5 s after the first found the connection not ready) | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Reboot with a note still queued: it uploads | untested | |
| App killed mid-recording: recording rebuilt on next start | works: swiped away after 37 s (HyperOS kills the process even with a foreground service); on reopening the 37 s note was there, marked recovered, and uploaded | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Pause / Resume from the notification | works: the app's screen followed; a 22.8 s recording with a pause gave a 17.9 s note | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Waveform with the native recorder | works (after the listener permission fix) | 2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Low battery | untested | |
| 2 hour recording | untested | |

## Phase notes

### Phase 0: toolchain, app runs, record and upload with the screen on

**Done, checked on a real phone** (Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0, 2026-11-05):
- The app starts (cold start 1.04 s) and shows the same UI as the website, branded aution. No console or CSP errors.
- Microphone: Android's own prompt appears on the first Record (wry asks for it); recording works with the screen on;
  a 57 s note was saved on the device and its level meter responds to speech.
- One-tap pairing with the server (`https://aution.remeinium.com`): the approval page opened in the **system browser**
  (`src/native/links.ts`), Google sign-in there, the app connected by itself and the note uploaded ("Uploaded").
  So the server already accepts the app's origin `https://tauri.localhost` (it sends `*`).
- Settings has no PWA "Install" section in the app.
- Debug APK: `npx tauri android build --debug --apk --target aarch64`, 136 MB (unoptimised Rust with debug symbols).

**Does not work yet** (expected, needs phase 2): with the screen off the WebView recording keeps running but
records silence. Measured: AudioRecord switches from `fine` to `mute` as soon as the screen goes off.

Things found on the way:
- Xiaomi/HyperOS blocks `adb install` (`INSTALL_FAILED_USER_RESTRICTED`) even with "Install via USB" on and no
  prompt shown. Workaround: `adb push` the APK to Downloads and install it from the Files app.
- In debug mode the phone shows up as USB id `18d1:4ee7` (Google), not Xiaomi's `2717`; the udev rule needs `18d1`.
- The server's approval page reuses the browser's server session, so switching Google accounts means signing out
  at `https://aution.remeinium.com/account` first (see "Needs from the server").
- The Recording setting "The Record shortcut on your home screen always does this" refers to the PWA shortcut; the
  native app has no shortcut yet.

### Phase 1: platform adapter

Done: `src/native/` with the four interfaces, a web implementation (today's code) and a runtime choice; external
links to the system browser; the token split for the secure store. The web app is unchanged:
`npm run test:e2e` passes 22/22, 77 unit tests pass. Inside the app every part still uses the web code (the native
ones come in phases 2 to 4). On the phone (2026-11-05) the app ran through this layer: the web recorder and uploader
under `choose()`, and external links through the opener plugin, all as above.

### Phase 2: native recorder

**Done, checked on a real phone** (2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0):
- On Android, Record now runs in a native **microphone foreground service** (`src-tauri/plugins/aution-recorder`),
  not in the WebView. A silent notification ("Recording", running clock, **Pause/Resume** and **Stop**) stays in
  the notification drawer; Android asked for the notification permission on the first Record.
- **Screen off works**: 61 s of screen-off speech recorded at normal loudness (the WebView recorder got silence).
- **Behind other apps** and **Stop from the notification** work; the note is added when aution is next opened.
- **Killed mid-recording** (swiped away): the audio up to that moment comes back as a *recovered* note and uploads.
- **Pause/Resume** from the notification; the app follows. The waveform follows the native level.
- Format: **Ogg/Opus 48 kHz mono** on Android 10+ (about 5 KB/s at the default bitrate), AAC (ADTS) below Android 10
  (*untested*). Both stay playable when cut off mid-write, which is what makes recovery work.
- **Battery**: % at start and stop is stored with the note and shown in the Library ("battery 75% → 75%"). Since
  2026-11-10 the per-second save also stores the latest reading, so a recovered note gets an end value too
  (*untested on the phone*).
- The note goes into the same library and uploader as before: the audio is copied into IndexedDB first, the note
  second, and the native files are deleted only after both are saved.

**How it fits together**: `src/native/tauri-recorder.ts` (UI side, same `Recorder` interface as the web recorder)
→ Tauri IPC → `RecorderPlugin.kt` (commands and events) → `RecorderService.kt` (MediaRecorder, notification, wake
lock) → `filesDir/recordings/<id>/audio.ogg` + `meta.json` (rewritten every second). The audio bytes come back
through a Rust command (`read_recording`) as one binary response.

**Battery numbers**: the short tests above used under 1% (75% → 75%). A 2-hour measurement is still to do.

**Limitations and untested**:
- **HyperOS kills the app when it is swiped away**, recording included (logged as `handleSwipeKill`); stock Android
  keeps a foreground service running. What is recorded up to then is kept. To avoid it on Xiaomi: lock aution in the
  recent-apps screen, or set Battery saver to "No restrictions" for it. Worth a line in the user guide.
- Incoming phone call: the service watches for the system silencing the microphone and shows a warning. *Untested*.
- Not applied natively yet: the microphone choice, and the noise suppression / echo / auto-gain settings (the phone's
  standard `MIC` source is used, with whatever processing the phone applies to it). Bluetooth headset microphones are not routed
  (*untested*: the phone's own microphone is used).
- 2-hour recording, low battery and reboot during a recording: *untested*.
- The web recorder is still used in the browser and as the fallback if the plugin is missing.

### Phase 3: native uploader

**Done, checked on a real phone** (2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0):
- On Android, waiting notes go to a native **outbox** (`filesDir/outbox/<id>/audio` + `entry.json`) and a
  **WorkManager** worker sends them: the same `POST /v1/notes`, multipart `meta` + `audio`, the device token, and
  the note id as `Idempotency-Key` (409 counts as done). Backoff and `Retry-After` follow `src/lib/rules.ts`; the
  Kotlin copy is `Rules.kt`, and a unit test checks that the two agree.
- Uploads continue **with the app closed**: airplane mode on, record, swipe the app away, airplane mode off. Android
  started the app in the background and the note uploaded about 14 s later.
- The library shows the outbox state whenever the app is open (on its way, waiting with when it tries again,
  "Waiting for Wi-Fi." / "Waiting for a connection.", refused with the reason, uploaded).
- **Nothing is deleted before the server confirms**: the outbox deletes its copy only after a 2xx/409, and IndexedDB
  keeps the note's audio until the app has seen "done", then follows "Keep audio after upload".
- **The token is in the Android Keystore** (this was planned for phase 4, but the background worker must read it
  without the UI): AES-256-GCM under a Keystore key, ciphertext in private preferences. On first start the token was
  moved out of IndexedDB (checked: IndexedDB now holds an empty token). Nothing logs it.
- "Upload waiting notes now" and a note's retry also re-arm notes the server refused. A rename made before the upload
  goes along with it.
- New setting **Wi-Fi only** (Android app only): the work waits for an unmetered network. *Untested on the phone.*
- **Reboot**: WorkManager reschedules its jobs after a restart (it adds `RECEIVE_BOOT_COMPLETED`). *Untested on the phone* (skipped).

**Xiaomi / Redmi / POCO (MIUI, HyperOS): the Autostart switch.** With it off (the default for a newly installed
app), HyperOS does not start a closed app for its scheduled work, so uploads wait until the app is opened (they then
go within seconds). There is no permission dialog for it on any Android version; an app can only open the screen with
the switch. aution detects the switch's state (MIUI app-op 10008) and shows "To upload while aution is closed, this
phone needs its Autostart switch on" with a button that opens it, at the top of Library and in Settings → Uploads, on
those phones only, until it is on. Checked: the notice appeared, the button opened the right screen, the notice went
away once the switch was on.

**How it fits together**: `src/lib/uploader.ts` `kickUploads()` → `src/native/tauri-uploader.ts` (hands notes over,
reads the outbox back into IndexedDB) → `UploaderPlugin.kt` → `Outbox.kt` + `Uploads.kt` (WorkManager) →
`UploadWorker.kt` → the server. Audio reaches the outbox by **moving** the native recording's file (`adopt`, no copy)
or, for imported and older notes, in base64 pieces (`stage`).

**Permissions added by WorkManager**: `ACCESS_NETWORK_STATE` and `RECEIVE_BOOT_COMPLETED` (what it needs, as the brief
allows). The uploader adds `FOREGROUND_SERVICE_DATA_SYNC` for long uploads (above). Its exported components are protected by system-only permissions (`BIND_JOB_SERVICE`, `DUMP`).

**Limitations and untested**:
- **Long uploads (fixed 2026-11-10, after a 37 MB and a 43 MB import never finished).** Three causes: Node ended
  any request longer than 5 minutes (`requestTimeout`), Android stops background work after 10 minutes, and a retry
  re-sent the whole file even when the server already had it (its answer had been lost). Now: the server has no
  total request time limit and no size limit (`MAX_UPLOAD_MB`, `STT_MAX_MB` unset by default; Caddy allows 1 GB per upload,
  about 70 hours at the default bitrate, and answers 413 "too large" above that); uploads of 2 MB and more run as a foreground job with an "Uploading a recording" notification
  (`FOREGROUND_SERVICE_DATA_SYNC`); and a retry first asks `GET /v1/notes/<id>` and skips the upload when the server
  already stores the note. An interrupted upload still restarts from the beginning (no resumable uploads). Android
  may refuse the foreground job when the app is not on screen (Android 12+); that upload then runs as ordinary
  background work, with the 10-minute limit.
  The same 5-minute limit hid in the server's **transcription** request: Node's `fetch` gives up when response
  headers take over 300 s (undici's `headersTimeout`), and Whisper answers only when the whole file is done. The
  15-minute note failed with "fetch failed" after 5 m 8 s. The transcription request now uses an undici `Agent`
  without those timeouts; its own timeout grows with the file (15 min + 2 min per MB).
- Renames and tag changes after the upload are still sent by the page (`flushEdits`), so only while the app is open.
- Turning "Upload automatically" off does not stop notes already handed to the outbox.
- Wi-Fi only, reboot, a 401 after signing out on the server, and a large file: *untested on the phone*.

### Phase 4: pairing and the token in the Keystore

Mostly built in earlier phases, so this phase added no code:
- One-tap pairing through the system browser (phase 0): approval page in the browser, the app polls and connects.
  Checked again with the **release** APK on 2026-11-10: installed fresh, connected, recorded, uploaded.
- The token lives in the Android Keystore (phase 3), moved out of IndexedDB on first start.
- "Sign out of this device" calls `DELETE /v1/devices/:id` and clears the token; inside the app that removes it from
  the Keystore (`writeToken` → `SecureStore.remove`). *Sign-out on the phone not separately checked.*

### Phase 5: release

**Done**: signing key outside the repo, Gradle signing from the environment, `npm run android:release`, the versionCode
scheme, `.github/workflows/android.yml`, the download link in the website's Settings, and the build and release
sections above. Release builds use a size-tuned Rust profile (`lto`, `opt-level = "s"`, `strip`) and R8, and carry
arm64 + armv7 only.

**Checked on a real phone** (2026-11-10, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0): the signed release APK (0.2.0, 12.7 MB) installed from the Files app next to the
debug build, opened, connected through the system browser, recorded with the native recorder and uploaded.

**Published**: tag `v0.2.0` → the workflow built the APK on GitHub (12.7 MB) and attached it to
https://github.com/remeinium/aution/releases/tag/v0.2.0. Downloaded through the website's link
(`releases/latest/download/aution.apk`): the signature is the release key above, so it updates the APK built locally.

**Not checked**: the download link on the live website (it appears once the website is redeployed); installing on an
armv7 phone.

### Phase 6: iOS

*To be written.*
