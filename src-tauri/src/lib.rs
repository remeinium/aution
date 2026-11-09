// SPDX-License-Identifier: AGPL-3.0-only
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opens the server's approval and account pages in the system browser (https only, see capabilities/).
        .plugin(tauri_plugin_opener::init())
        // Records with the screen off: a microphone foreground service on Android (see plugins/aution-recorder).
        .plugin(tauri_plugin_aution_recorder::init())
        // Uploads in the background, also after a reboot, and keeps the token in the Keystore (see plugins/aution-uploader).
        .plugin(tauri_plugin_aution_uploader::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
