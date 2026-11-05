# jssayso for Android (Tauri 2)

The native app wraps the same React UI as the website and adds what a browser cannot do: recording with the screen
off, uploading in the background (also after a reboot), and keeping the device token in the Android Keystore.
iOS comes later (see the end).

> **Status: in progress.** Each phase below says what has been checked **on a real phone**. Anything not run on a
> phone is marked *untested*.

> ⚠️ **The application id `com.remeinium.jss` becomes permanent the moment an APK reaches a real user.** Android
> treats a different id as a different app, so changing it later breaks updates for everyone. It is set in
> `src/brand.ts` and `src-tauri/tauri.conf.json` (`tests/brand.test.ts` fails if they disagree). Confirm it before
> the first release.

## Name and identity, in one place

| What | Where |
|---|---|
| Display name `jssayso`, tagline, app id, website `https://jss.remeinium.com` | `src/brand.ts` |
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
| Android 14 needs a `microphone` foreground service | *to be checked in phase 2* | |

## Libraries added, and their licences

All must be compatible with AGPL-3.0.

| Library | Used for | Licence |
|---|---|---|
| `@tauri-apps/api` 2.12 (npm) | calling native code from the UI | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-opener` 2.7 (npm) + `tauri-plugin-opener` 2.7 (crate) | opening pages in the system browser | Apache-2.0 OR MIT |

Build tools (not shipped in the APK): Amazon Corretto 21 (GPLv2 with Classpath Exception), Android SDK
command-line tools and NDK (Android SDK licence).

## Needs from the server

The other session owns `server/`. Please pass these on:

1. **CORS for the app's origin.** Requests the UI makes from inside the app (pairing, rename, delete, account,
   names) come from origin `https://tauri.localhost`. `ALLOWED_ORIGIN` takes one value (default `*`). If production
   sets it to the website's origin, the app breaks. Needed: either keep `*` for `/v1`, or accept a comma-separated
   list and echo the matching `Origin` (with `Vary: Origin`), and document that `https://tauri.localhost` must be
   in it.

2. **Rename what people see on the server's pages to jssayso.** The approval page (`server/src/pairing.ts`, for
   example "…your own voicebrain app…"), the sign-out page (`server/src/auth.ts`, "You are signed out of
   voicebrain…") and the other server-rendered pages still say voicebrain. The owner wants the brand jssayso
   everywhere a person reads it. Ideally the server reads the name from one setting (an env var such as
   `BRAND_NAME=jssayso`) so it matches the app's `src/brand.ts`.
3. **Let someone switch Google accounts from the approval page.** The page reuses the server's own browser session
   (`vb_session`, 14 days), so a person signed in as account A never reaches Google's account chooser (which
   `prompt: 'select_account'` would show). Seen on the owner's phone on 2026-11-05: it kept approving as the old
   account, and signing out of the website did not help (that only drops the website's device token). Needed: show
   "Signed in as A · Use a different account" on `GET /pair`, which ends the session and restarts sign-in.

## Build it locally

*To be written in phase 5.* The toolchain used here: JDK 21 (Corretto) in `~/.local/jdk`, Android SDK in
`~/Android/Sdk` (platform-tools, latest platform and build-tools, NDK), Rust targets
`aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

## Checklist on a real phone

Filled in on a real phone.

| Check | Result | Date, phone, Android version |
|---|---|---|
| App starts, shows the UI | works: cold start 1.04 s, no console or CSP errors | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Microphone permission prompt, then recording works (screen on) | works: system prompt "Allow jssayso to record audio?", 57 s note saved (188 KB); level meter responds (peak 0.06 quiet, 0.26 speaking) | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Pairing with one tap, then upload (screen on) | works: approval page opened in the system browser, Google sign-in, note shows "Uploaded" | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| 5 minute recording with the screen off | **fails with the web recorder** (as expected): with the screen off Android feeds the WebView silence (AudioRecord stats switch from `fine` to `mute`, 12 s muted in a 20 s test). Fixed by the native recorder in phase 2 | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Switching to other apps while recording | untested | |
| Incoming phone call while recording | untested | |
| Airplane mode, then back online: queued notes upload | untested | |
| Reboot with a note still queued: it uploads | untested | |
| App killed mid-recording: recording rebuilt on next start | untested | |
| Low battery | untested | |
| 2 hour recording | untested | |

## Phase notes

### Phase 0: toolchain, app runs, record and upload with the screen on

**Done, checked on a real phone** (Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0, 2026-11-05):
- The app starts (cold start 1.04 s) and shows the same UI as the website, branded jssayso. No console or CSP errors.
- Microphone: Android's own prompt appears on the first Record (wry asks for it); recording works with the screen on;
  a 57 s note was saved on the device and its level meter responds to speech.
- One-tap pairing with `https://vb.kusaldarshana.com`: the approval page opened in the **system browser**
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
  at `https://vb.kusaldarshana.com/account` first (see "Needs from the server").
- The Recording setting "The Record shortcut on your home screen always does this" refers to the PWA shortcut; the
  native app has no shortcut yet.

### Phase 1: platform adapter

Done: `src/native/` with the four interfaces, a web implementation (today's code) and a runtime choice; external
links to the system browser; the token split for the secure store. The web app is unchanged:
`npm run test:e2e` passes 22/22, 77 unit tests pass. Inside the app every part still uses the web code (the native
ones come in phases 2 to 4). On the phone (2026-11-05) the app ran through this layer: the web recorder and uploader
under `choose()`, and external links through the opener plugin, all as above.

### Phase 6: iOS

*To be written.*
