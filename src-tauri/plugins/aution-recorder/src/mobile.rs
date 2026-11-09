// SPDX-License-Identifier: AGPL-3.0-only
use serde::{de::DeserializeOwned, Deserialize};
use std::{path::PathBuf, sync::OnceLock};
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_aution_recorder);

pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> crate::Result<AutionRecorder<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("com.remeinium.aution.recorder", "RecorderPlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_aution_recorder)?;
  Ok(AutionRecorder { handle, directory: OnceLock::new() })
}

#[derive(Deserialize)]
struct Directory {
  path: String,
}

pub struct AutionRecorder<R: Runtime> {
  handle: PluginHandle<R>,
  directory: OnceLock<PathBuf>,
}

impl<R: Runtime> AutionRecorder<R> {
  /// The app-private folder the Kotlin side records into (`filesDir/recordings`), asked once and remembered.
  pub fn directory(&self) -> crate::Result<PathBuf> {
    if let Some(path) = self.directory.get() {
      return Ok(path.clone());
    }
    let answer: Directory = self.handle.run_mobile_plugin("directory", ())?;
    Ok(self.directory.get_or_init(|| PathBuf::from(answer.path)).clone())
  }
}
