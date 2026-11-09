// SPDX-License-Identifier: AGPL-3.0-only
use serde::de::DeserializeOwned;
use std::path::PathBuf;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, _api: PluginApi<R, C>) -> crate::Result<AutionRecorder<R>> {
  Ok(AutionRecorder(std::marker::PhantomData))
}

/// On desktop the app records in the WebView (src/native picks the web recorder), so there is nothing native here.
pub struct AutionRecorder<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> AutionRecorder<R> {
  pub fn directory(&self) -> crate::Result<PathBuf> {
    Err(crate::Error::Unsupported)
  }
}
