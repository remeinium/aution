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

*To be written in phase 5.* The toolchain used here: JDK 21 (Corretto) in `~/.local/jdk`, Android SDK in
`~/Android/Sdk` (platform-tools, latest platform and build-tools, NDK), Rust targets
`aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

## Checklist on a real phone

Filled in on a real phone.

| Check | Result | Date, phone, Android version |
|---|---|---|
| App starts, shows the UI | works: cold start 1.04 s, no console or CSP errors | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
| Microphone permission prompt, then recording works (screen on) | works: system prompt "Allow aution to record audio?", 57 s note saved (188 KB); level meter responds (peak 0.06 quiet, 0.26 speaking) | 2026-11-05, Redmi Note 14 (24117RN76G), Android 16, HyperOS 3.0 |
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
- The app starts (cold start 1.04 s) and shows the same UI as the website, branded aution. No console or CSP errors.
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
