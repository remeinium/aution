// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.recorder

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class StartArgs {
  lateinit var id: String
  var bitrate: Int = 32000
}

@InvokeArg
class IdArgs {
  lateinit var id: String
}

/**
 * The UI's side of the native recorder: commands (start, pause, resume, mark, stop, status, finished, discard) and
 * events ("state", "level", "warning", "finished", "failed"). The recording itself runs in [RecorderService].
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
  ]
)
class RecorderPlugin(private val activity: Activity) : Plugin(activity), RecorderListener {
  /** The start that is waiting for the service to say it is recording (or that it failed). */
  private var pendingStart: Invoke? = null

  override fun load(webView: WebView) {
    super.load(webView)
    RecorderService.listener = this
    // A recording cut off by a dead process is kept as a recovered note. Only when nothing is recording now.
    if (RecorderService.current?.state.let { it == null || it == "idle" }) RecordingStore.finaliseOrphans(activity)
  }

  override fun onDestroy() {
    if (RecorderService.listener === this) RecorderService.listener = null
    super.onDestroy()
  }

  @Command
  fun directory(invoke: Invoke) {
    invoke.resolve(JSObject().put("path", RecordingStore.root(activity).absolutePath))
  }

  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    if (!RecordingStore.isValidId(args.id)) { invoke.reject("Not a valid recording id."); return }
    if (getPermissionState("microphone") != PermissionState.GRANTED) {
      // Ask for the microphone, and on Android 13+ for the notification that carries the Stop button.
      val aliases = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) arrayOf("microphone", "notifications") else arrayOf("microphone")
      requestPermissionForAliases(aliases, invoke, "afterPermission")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") == PermissionState.PROMPT) {
      requestPermissionForAlias("notifications", invoke, "afterPermission")
      return
    }
    beginService(invoke, args)
  }

  @PermissionCallback
  private fun afterPermission(invoke: Invoke) {
    if (getPermissionState("microphone") != PermissionState.GRANTED) {
      invoke.reject("Microphone access is off. Turn it on for this app in the phone's Settings to record.", "permission")
      return
    }
    // Recording works without the notification permission; the notification is just hidden then.
    beginService(invoke, invoke.parseArgs(StartArgs::class.java))
  }

  private fun beginService(invoke: Invoke, args: StartArgs) {
    val running = RecorderService.current
    if (running != null && running.state != "idle") { invoke.resolve(status(running)); return }
    pendingStart?.reject("Superseded by a new start.")
    pendingStart = invoke
    val intent = Intent(activity, RecorderService::class.java)
      .setAction(RecorderService.ACTION_START)
      .putExtra(RecorderService.EXTRA_ID, args.id)
      .putExtra(RecorderService.EXTRA_BITRATE, args.bitrate)
    try {
      ContextCompat.startForegroundService(activity, intent)
    } catch (error: Exception) {
      pendingStart = null
      invoke.reject("Android did not allow recording to start: ${error.message}")
    }
  }

  @Command
  fun pause(invoke: Invoke) {
    RecorderService.current?.pause()
    invoke.resolve(status(RecorderService.current))
  }

  @Command
  fun resume(invoke: Invoke) {
    RecorderService.current?.resume()
    invoke.resolve(status(RecorderService.current))
  }

  @Command
  fun mark(invoke: Invoke) {
    val count = RecorderService.current?.mark() ?: 0
    invoke.resolve(JSObject().put("marks", count))
  }

  /** Stops and resolves with the finished recording, or `{ recording: null }` when nothing was captured. */
  @Command
  fun stop(invoke: Invoke) {
    val finished = RecorderService.current?.stopAndSave()
    invoke.resolve(JSObject().put("recording", finished?.let { describe(it) } ?: JSONObject.NULL))
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(status(RecorderService.current))
  }

  /** Finished recordings that the UI has not taken into its library yet (also ones stopped from the notification). */
  @Command
  fun finished(invoke: Invoke) {
    val list = JSArray()
    for (recording in RecordingStore.all(activity)) if (recording.state == "done") list.put(describe(recording))
    invoke.resolve(JSObject().put("recordings", list))
  }

  /** Deletes a recording's files. The UI calls this only after the audio is safely in its own storage. */
  @Command
  fun discard(invoke: Invoke) {
    val args = invoke.parseArgs(IdArgs::class.java)
    if (!RecordingStore.isValidId(args.id)) { invoke.reject("Not a valid recording id."); return }
    if (RecorderService.current?.let { it.state != "idle" && it.recordingId == args.id } == true) {
      invoke.reject("That recording is still running.")
      return
    }
    RecordingStore.delete(activity, args.id)
    invoke.resolve()
  }

  private fun status(service: RecorderService?): JSObject {
    val state = service?.state ?: "idle"
    val result = JSObject().put("state", state)
    if (service != null && state != "idle") {
      result.put("id", service.recordingId).put("elapsedMs", service.elapsedMs()).put("marks", service.markCount())
    }
    return result
  }

  private fun describe(recording: Recording): JSObject = JSObject.fromJSONObject(recording.toJson())

  // ---- RecorderListener: forwarded to the UI as events ----

  override fun onState(service: RecorderService) {
    val waiting = pendingStart
    if (waiting != null && service.state == "recording") {
      pendingStart = null
      waiting.resolve(status(service))
    }
    trigger("state", status(service))
  }

  override fun onLevel(level: Float) {
    trigger("level", JSObject().put("level", level.toDouble()))
  }

  override fun onWarning(message: String?) {
    trigger("warning", JSObject().put("message", message ?: JSONObject.NULL))
  }

  override fun onFinished(recording: Recording) {
    trigger("finished", JSObject().put("id", recording.id))
  }

  override fun onFailed(message: String) {
    val waiting = pendingStart
    pendingStart = null
    waiting?.reject(message)
    trigger("failed", JSObject().put("message", message))
  }
}
