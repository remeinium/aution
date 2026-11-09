// SPDX-License-Identifier: AGPL-3.0-only
use tauri::{command, ipc::Response, AppHandle, Runtime};

use crate::{AutionRecorderExt, Error, Result};

/// A note id is a UUID. Checking the shape keeps a crafted id from naming a path outside the recordings folder.
pub(crate) fn valid_id(id: &str) -> bool {
  id.len() == 36
    && id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// The audio of one recording, as raw bytes (an ArrayBuffer in the UI).
#[command]
pub(crate) async fn read_recording<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Response> {
  if !valid_id(&id) {
    return Err(Error::Invalid("not a recording id"));
  }
  let folder = app.aution_recorder().directory()?.join(&id);
  for name in ["audio.ogg", "audio.aac"] {
    let path = folder.join(name);
    if path.is_file() {
      return Ok(Response::new(std::fs::read(path)?));
    }
  }
  Err(Error::Invalid("this recording has no audio file"))
}

#[cfg(test)]
mod tests {
  use super::valid_id;

  #[test]
  fn ids_must_be_uuids() {
    assert!(valid_id("0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b"));
    for bad in ["", "../../shared_prefs/x", "0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6", "0b9e8a52/3c1d-4f7e-9a2b-1c2d3e4f5a6b", "0b9e8a52-3c1d-4f7e-9a2b-1c2d3e4f5a6g"] {
      assert!(!valid_id(bad), "{bad}");
    }
  }
}
