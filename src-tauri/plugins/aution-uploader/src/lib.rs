// SPDX-License-Identifier: AGPL-3.0-only
//! aution's native uploader. Everything is Kotlin (android/): the outbox, a WorkManager worker that sends the notes
//! with backoff (Android reschedules it after a reboot), and the Keystore token store. Audio reaches the outbox either
//! by moving a native recording's file (`adopt`) or in base64 pieces (`stage`): on Android, Tauri's IPC from the page
//! is JSON text, so raw bytes cannot be sent in one go. Rust only registers the plugin.
use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("aution-uploader")
    .setup(|_app, _api| {
      #[cfg(target_os = "android")]
      _api.register_android_plugin("com.remeinium.aution.uploader", "UploaderPlugin")?;
      Ok(())
    })
    .build()
}
