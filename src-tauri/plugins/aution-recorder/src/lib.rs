// SPDX-License-Identifier: AGPL-3.0-only
//! aution's native recorder. The recording itself is Kotlin (android/): a foreground service of type microphone, so
//! Android keeps giving it real audio with the screen off. Rust only hands finished audio files to the UI as raw
//! bytes (`read_recording`), which is far cheaper than base64 through JSON.
use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::AutionRecorder;
#[cfg(mobile)]
use mobile::AutionRecorder;

pub trait AutionRecorderExt<R: Runtime> {
  fn aution_recorder(&self) -> &AutionRecorder<R>;
}

impl<R: Runtime, T: Manager<R>> AutionRecorderExt<R> for T {
  fn aution_recorder(&self) -> &AutionRecorder<R> {
    self.state::<AutionRecorder<R>>().inner()
  }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("aution-recorder")
    .invoke_handler(tauri::generate_handler![commands::read_recording])
    .setup(|app, api| {
      #[cfg(mobile)]
      let recorder = mobile::init(app, api)?;
      #[cfg(desktop)]
      let recorder = desktop::init(app, api)?;
      app.manage(recorder);
      Ok(())
    })
    .build()
}
