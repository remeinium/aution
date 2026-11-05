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
| WebView microphone stops when the screen turns off | *untested*: to be measured on the phone in phase 0 | |
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

## Build it locally

*To be written in phase 5.* The toolchain used here: JDK 21 (Corretto) in `~/.local/jdk`, Android SDK in
`~/Android/Sdk` (platform-tools, latest platform and build-tools, NDK), Rust targets
`aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

## Checklist on a real phone

Filled in on a real phone; nothing here has been run yet.

| Check | Result | Date, phone, Android version |
|---|---|---|
| App starts, shows the UI | untested | |
| Microphone permission prompt, then recording works (screen on) | untested | |
| Upload works (screen on) | untested | |
| 5 minute recording with the screen off | untested | |
| Switching to other apps while recording | untested | |
| Incoming phone call while recording | untested | |
| Airplane mode, then back online: queued notes upload | untested | |
| Reboot with a note still queued: it uploads | untested | |
| App killed mid-recording: recording rebuilt on next start | untested | |
| Low battery | untested | |
| 2 hour recording | untested | |

## Phase notes

### Phase 0: toolchain, app runs, record and upload with the screen on

Done (no phone yet):
- Toolchain installed: JDK 21, Android SDK (platform 37, build-tools 37), NDK 30.0.16248370, Rust Android targets.
- `tauri android init`, then the generated project was locked down: no backup, no cleartext in release, only the
  permissions the WebView microphone needs, no Android TV entry, no FileProvider, the app's own icon.
- A debug APK builds: `npx tauri android build --debug --apk --target aarch64`. 136 MB, nearly all of it the
  unoptimised Rust library with debug symbols; a release build will be far smaller (measured in phase 5).
- Checked in the APK with `aapt2`: id `com.remeinium.jss.debug`, label jssayso, the three permissions above,
  `allowBackup=false`.

Not done yet, needs a phone: the app starting, the microphone prompt, recording and uploading with the screen on.
**Untested.**

### Phase 1: platform adapter

Done: `src/native/` with the four interfaces, a web implementation (today's code) and a runtime choice; external
links to the system browser; the token split for the secure store. The web app is unchanged:
`npm run test:e2e` passes 22/22, 77 unit tests pass. Inside the app every part still uses the web code (the native
ones come in phases 2 to 4). **Untested on a phone.**

### Phase 6: iOS

*To be written.*
