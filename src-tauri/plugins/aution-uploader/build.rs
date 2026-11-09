// SPDX-License-Identifier: AGPL-3.0-only
// Every command the UI may call, Kotlin ones included: tauri-plugin generates an `allow-<command>` permission for each.
// register_listener / remove_listener are Tauri's built-in commands behind addPluginListener (the plugin's events).
const COMMANDS: &[&str] = &["stage", "adopt", "enqueue", "schedule", "uploads", "forget", "secret", "background", "register_listener", "remove_listener"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
