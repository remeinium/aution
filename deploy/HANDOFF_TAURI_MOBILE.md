# Hand-off: the native mobile app (Tauri 2, Android first)

Paste the prompt below into a Claude Code session started **on the owner's laptop**, inside a fresh clone of this repo.
It needs the Android toolchain, so it cannot run on the VPS. Another session keeps working on `server/` and the docs at
the same time; the lanes below keep the two from colliding.

Laptop prerequisites (the owner does these once): Android Studio with an SDK (API 34 or newer) and the NDK, JDK 17,
Rust (`rustup`) with the Android targets (`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`),
Node 22.18+ (24 recommended), `gh auth login` as the repo owner, a phone with USB debugging on (an emulator is not enough for background recording).

---

```
You are building the native mobile app for aution: a Tauri 2 app, Android first (iOS later), that wraps the existing
React UI and adds the things a browser cannot do. You are on the owner's laptop with the Android toolchain installed.
Another Claude session works on server/ and the docs at the same time on the same repo, so stay inside your lane (below).

READ FIRST, in this order: README.md, design.md, server/README.md (sections "Sign-in with Google", "Who sorts the notes",
"Using it from coding agents"), then src/lib/{recorder,uploader,db,notes,connect,server,settings,types}.ts,
src/components/ConnectCard.tsx, src/pages/{RecordPage,SettingsPage}.tsx, public/sw.js, server/src/ingest.ts,
src-tauri/ (tauri.conf.json, Cargo.toml, src/lib.rs, capabilities/), scripts/e2e.mjs.

WHAT EXISTS
- A Vite + React + TypeScript PWA. It records with MediaRecorder and a screen wake lock (the screen has to stay on), keeps
  notes and audio in IndexedDB (database name "trapper-voice": keep it, phones already have notes in it), and uploads
  through a service worker with Background Sync to the server's REST API (POST /v1/notes multipart with an
  Idempotency-Key, PATCH/DELETE /v1/notes/:id, GET /v1/notes for names and Drive links). The device gets its own token
  from the one-tap pairing flow (POST /v1/pair/start, poll /v1/pair/poll; the approval page opens on the server).
- src-tauri/ is an unmodified Tauri 2 desktop skeleton (the crate already builds as staticlib + cdylib). Its identifier
  is a leftover and must change (see NAME).

GOAL: a signed Android APK that non-developers can install, which
 1. runs the same UI;
 2. records with the SCREEN OFF and while other apps are in front, without being killed;
 3. uploads reliably in the background, with retry, also after a reboot;
 4. pairs with one tap (system browser for the approval page, the app polls and receives its token);
 5. keeps the device token in secure storage, not in plain IndexedDB;
 6. is built and signed by a script and by CI, and can be offered for download.

WHY NATIVE (verify each claim against the current docs before relying on it): Tauri's Android WebView serves the app from a
custom protocol where service workers are not available, Android pauses a backgrounded WebView, and microphone capture
from a WebView stops when the screen turns off. Android 14 also requires a foreground service of type "microphone"
(permission FOREGROUND_SERVICE_MICROPHONE) for recording in the background.

PHASES. Finish and commit one before starting the next. After each, run the checks and write a short note in
docs/mobile.md saying what works on a REAL PHONE and what does not.
 0. Toolchain: `tauri android init`, the app starts on an emulator and on the phone and shows the UI. Microphone
    permission works. Fix the CSP and anything else the WebView needs. Record and upload work with the screen ON (same as
    the PWA). Hide the PWA-only parts (install prompt) inside the native app.
 1. Platform adapter: add src/native/ with small interfaces (Recorder, Uploader, SecureStore, Platform) whose default
    implementation is today's web code, and a Tauri implementation chosen at runtime. The UI must not change and the web
    app must keep working: scripts/e2e.mjs must still pass.
 2. Native recorder: a Kotlin Tauri mobile plugin (start, pause, resume, stop, mark moments, level events for the
    waveform). A foreground service (type microphone) with a notification that has a Stop button; audio written in chunks to
    app-private storage so an interrupted recording is rebuilt on next start (the web app already does this: keep the
    behaviour); handles phone calls, audio focus, Bluetooth microphones and the process being killed. Opus if the device
    supports it, else AAC. Record the battery level at start and stop into the note (a field the UI can show) so real
    battery numbers can be collected.
 3. Native uploader: persistent queue, WorkManager (or Rust) with backoff, honours Retry-After, optional Wi-Fi-only,
    resumes after reboot, uses the same API and idempotency semantics as the web app (read server/src/ingest.ts), and tells
    the UI through events. "Upload waiting notes now" still works. No audio is deleted before the server confirmed it.
 4. Pairing and token: open the approval page with the system browser (the opener plugin), keep polling in the app,
    store the token in the Android Keystore (secure-storage plugin or a small custom one). Signing out clears it and
    disconnects the device on the server (the web app already calls DELETE /v1/devices/:id).
 5. Release: Gradle signing from environment variables or a keystore file OUTSIDE the repo (never commit it, never print it);
    `tauri android build --apk`; a versionCode scheme; a GitHub Actions workflow that builds a signed APK on a version
    tag and attaches it to the release; docs on how to build locally. Add the "Download the Android app" link in Settings
    (hidden inside the native app) driven by VITE_APK_URL, pointing at the latest release asset.
 6. iOS: needs a Mac. Only write down what is blocked and what would be reused.

CONSTRAINTS
- Security: never log the token; https only (cleartext only for localhost in debug builds); android:allowBackup=false;
  request only the permissions needed (RECORD_AUDIO, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE,
  POST_NOTIFICATIONS, INTERNET and what WorkManager needs). A voice note is private.
- Licence: the project is AGPL-3.0. Put "SPDX-License-Identifier: AGPL-3.0-only" at the top of the new source files, and list
  the licence of every plugin or library you add in docs/mobile.md. Do not add anything that is not AGPL-compatible.
- NAME: the product name is NOT decided yet. Keep the display name, the application id and the URLs in ONE place
  (tauri.conf.json plus a small src/brand.ts) so the rename is a one-line change. Use the placeholder id
  dev.aution.app for now, and WARN the owner clearly that no APK may go to real users before the final id is set,
  because changing the application id later breaks updates for everyone.
- Be honest: if something was not run on a real phone, say "untested". Prefer a smaller thing that works to a bigger one that
  almost works. Research current Tauri 2 mobile docs for plugin APIs; do not guess from memory.

LANES (another session is working at the same time)
- You own: src-tauri/**, src/native/**, src/lib/recorder.ts, src/lib/uploader.ts, src/lib/db.ts, public/sw.js,
  src/lib/connect.ts, the "Download the Android app" part of src/pages/SettingsPage.tsx, docs/mobile.md,
  .github/workflows/android.yml, package.json and vite.config.ts (keep their changes small and additive).
- You do NOT touch: server/**, src/pages/GuidePage.tsx, src/components/ChatGptCard.tsx, public/guide/**, README.md (put
  mobile notes in docs/mobile.md and tell the owner what to add to the README).
- If you need a server change (an API field, a limit), do not make it: write exactly what you need in docs/mobile.md under
  "Needs from the server" and tell the owner, who passes it on.

GIT
- Work in a worktree on a new branch: `git worktree add ../voicebrain-mobile -b feat/tauri-mobile origin/main`.
- Set the repo-local git identity to the owner's (ask for the name and email): the host blocks commits from other authors.
  Small commits, each with a clear message. Never push to main. Push the branch and open a pull request when a phase is done.
- Rebase on origin/main at the start of each phase.

CHECKS (run before every commit that touches code)
- Root: `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run test:e2e` (needs Chromium; see scripts/e2e.mjs).
- `cd server && npm test` only to confirm you broke nothing (Node 24, it uses node:sqlite).
- Add unit tests for the adapter layer and for any pure logic. For the native parts keep a manual checklist in docs/mobile.md
  and fill it in on the real phone: a 5 minute recording with the screen off; switching apps; an incoming call; airplane mode,
  then back online; a reboot with a note still queued; killing the app mid-recording; low battery; a 2 hour recording.

ASK THE OWNER whenever you need a phone or an emulator, a signing or store decision, or anything destructive.

FINAL REPORT for each phase: what works on a real phone (with evidence), what does not, the APK size, battery numbers
from the log, known limitations, and the next step.
```
