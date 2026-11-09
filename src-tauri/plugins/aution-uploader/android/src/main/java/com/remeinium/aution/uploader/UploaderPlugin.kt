// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.app.Activity
import android.util.Base64
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.lang.ref.WeakReference

@InvokeArg
class StageArgs {
  lateinit var id: String
  /** Where this piece starts in the file; the first piece is 0. */
  var offset: Long = 0
  /** The piece, base64. */
  lateinit var data: String
  /** True on the final piece: the file is complete. */
  var last: Boolean = false
}

@InvokeArg
class BackgroundArgs {
  /** "check" or "open". */
  lateinit var action: String
}

@InvokeArg
class EnqueueArgs {
  lateinit var id: String
  lateinit var meta: String
  lateinit var mime: String
  lateinit var fileName: String
}

@InvokeArg
class ScheduleArgs {
  var endpoint: String = ""
  var wifiOnly: Boolean = false
  /** Also retry notes the server refused, and ignore the wait after a failure ("Upload waiting notes now"). */
  var force: Boolean = false
  /** Ignore the wait after a failure (the connection has just come back, or the app was opened). */
  var ignoreBackoff: Boolean = false
  var onlyId: String? = null
}

@InvokeArg
class IdArgs {
  lateinit var id: String
}

@InvokeArg
class SecretArgs {
  /** "get", "set" or "remove". */
  lateinit var action: String
  lateinit var name: String
  var value: String? = null
}

/**
 * The UI's side of the native uploader: put a note's audio in the outbox ([stage] or [adopt]), hand the note over ([enqueue]), start the uploads ([schedule]), read where
 * each note stands ([uploads]) and drop the ones the UI has taken note of ([forget]). The "changed" event tells the UI
 * to read again. [secret] keeps the device token in the Android Keystore (see [Secrets]).
 */
@TauriPlugin
class UploaderPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private var current: WeakReference<UploaderPlugin>? = null
    private val main = Handler(Looper.getMainLooper())

    /** Called by the worker whenever a note's state changes; the UI reads the outbox again. */
    fun changed() {
      main.post { current?.get()?.trigger("changed", JSObject()) }
    }
  }

  override fun load(webView: WebView) {
    super.load(webView)
    current = WeakReference(this)
  }

  /**
   * Receives a note's audio piece by piece (base64; Tauri's IPC from the page is JSON text on Android). Pieces must
   * arrive in order; the file only becomes `audio` after the last one, so a half-sent file is never uploaded.
   */
  @Command
  fun stage(invoke: Invoke) {
    val args = invoke.parseArgs(StageArgs::class.java)
    if (!Outbox.isValidId(args.id)) { invoke.reject("Not a valid note id."); return }
    try {
      val part = Outbox.part(activity, args.id)
      if (args.offset == 0L) part.delete() else if (part.length() != args.offset) { invoke.reject("A piece of the audio went missing."); return }
      part.appendBytes(Base64.decode(args.data, Base64.DEFAULT))
      if (args.last && !part.renameTo(Outbox.audio(activity, args.id))) { invoke.reject("Could not finish the audio file."); return }
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Could not store the audio: ${error.message}")
    }
  }

  /**
   * Moves a native recording's audio (aution-recorder's `filesDir/recordings/<id>/`) into the outbox instead of copying
   * it through the page. Resolves `{ adopted: false }` when there is no such recording.
   */
  @Command
  fun adopt(invoke: Invoke) {
    val args = invoke.parseArgs(IdArgs::class.java)
    if (!Outbox.isValidId(args.id)) { invoke.reject("Not a valid note id."); return }
    invoke.resolve(JSObject().put("adopted", Outbox.adoptRecording(activity, args.id)))
  }

  /**
   * Xiaomi, Redmi and POCO phones (MIUI / HyperOS) do not start a closed app for its background work unless its
   * "Autostart" switch is on, and there is no permission dialog for it. "check" says whether this phone has that switch
   * and, when it can tell, whether it is on; "open" opens the screen with the switch.
   */
  @Command
  fun background(invoke: Invoke) {
    val args = invoke.parseArgs(BackgroundArgs::class.java)
    when (args.action) {
      "check" -> invoke.resolve(JSObject().put("autostartSwitch", Background.hasAutostartSwitch())
        .put("autostart", Background.autostartAllowed(activity) ?: JSONObject.NULL))
      "open" -> invoke.resolve(JSObject().put("opened", Background.openAutostartSettings(activity)))
      else -> invoke.reject("Unknown action.")
    }
  }

  @Command
  fun enqueue(invoke: Invoke) {
    val args = invoke.parseArgs(EnqueueArgs::class.java)
    if (!Outbox.isValidId(args.id)) { invoke.reject("Not a valid note id."); return }
    if (!Outbox.put(activity, args.id, args.meta, args.mime, args.fileName)) { invoke.reject("The audio was not staged."); return }
    invoke.resolve()
  }

  @Command
  fun schedule(invoke: Invoke) {
    val args = invoke.parseArgs(ScheduleArgs::class.java)
    Uploads.configure(activity, args.endpoint, args.wifiOnly)
    if (args.force || args.ignoreBackoff) {
      for (entry in Outbox.all(activity)) {
        if (args.onlyId != null && entry.id != args.onlyId) continue
        if (entry.state == "waiting" || (args.force && entry.state == "failed")) {
          Outbox.update(activity, entry.id) { it.copy(state = "waiting", nextAttemptAt = 0) }
        }
      }
    }
    Uploads.runNow(activity)
    invoke.resolve()
  }

  @Command
  fun uploads(invoke: Invoke) {
    val list = JSArray()
    for (entry in Outbox.all(activity)) {
      list.put(JSObject().put("id", entry.id).put("meta", entry.meta).put("state", entry.state).put("attempts", entry.attempts)
        .put("lastError", entry.lastError ?: JSONObject.NULL).put("nextAttemptAt", entry.nextAttemptAt)
        .put("uploadedAt", entry.uploadedAt ?: JSONObject.NULL))
    }
    val staged = JSArray()
    for (id in Outbox.stagedOnly(activity)) staged.put(id)
    invoke.resolve(JSObject().put("uploads", list).put("staged", staged).put("waitingFor", Uploads.waitingFor(activity) ?: JSONObject.NULL))
  }

  @Command
  fun forget(invoke: Invoke) {
    val args = invoke.parseArgs(IdArgs::class.java)
    if (!Outbox.isValidId(args.id)) { invoke.reject("Not a valid note id."); return }
    Outbox.forget(activity, args.id)
    invoke.resolve()
  }

  @Command
  fun secret(invoke: Invoke) {
    val args = invoke.parseArgs(SecretArgs::class.java)
    if (!Secrets.isValidName(args.name)) { invoke.reject("Not a valid secret name."); return }
    try {
      when (args.action) {
        "get" -> { invoke.resolve(JSObject().put("value", Secrets.get(activity, args.name) ?: JSONObject.NULL)); return }
        "set" -> Secrets.set(activity, args.name, args.value ?: run { invoke.reject("No value."); return })
        "remove" -> Secrets.remove(activity, args.name)
        else -> { invoke.reject("Unknown action."); return }
      }
      invoke.resolve()
    } catch (_: Exception) {
      // Never include the exception text: it could carry key material details. The UI keeps the token where it was.
      invoke.reject("The secure store is not available.")
    }
  }
}
