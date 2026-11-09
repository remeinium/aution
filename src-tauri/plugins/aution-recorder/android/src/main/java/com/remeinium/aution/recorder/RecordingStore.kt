// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.recorder

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * One recording on disk: `filesDir/recordings/<id>/audio.ogg` (or `.aac`) and `meta.json`. App-private storage, so no
 * other app can read it, and it is excluded from backups by the app's data-extraction rules.
 *
 * meta.json is rewritten every second while recording. If the process dies, the next start finds a meta that still says
 * "recording" and finalises it as recovered: Ogg and ADTS files stay playable when cut off mid-write.
 */
data class Recording(
  val id: String,
  /** Wall-clock start, ms since epoch. */
  val createdAt: Long,
  val mime: String,
  val fileName: String,
  /** "recording", "paused" or "done". */
  val state: String,
  /** Recorded time without pauses. */
  val durationMs: Long,
  /** Marked moments, ms from the start without pauses. */
  val marks: List<Long>,
  val recovered: Boolean,
  /** Battery percent at start and stop, or null when the phone did not say. */
  val batteryStart: Int?,
  val batteryEnd: Int?,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("createdAt", createdAt)
    .put("mime", mime)
    .put("fileName", fileName)
    .put("state", state)
    .put("durationMs", durationMs)
    .put("marks", JSONArray(marks))
    .put("recovered", recovered)
    .put("batteryStart", batteryStart ?: JSONObject.NULL)
    .put("batteryEnd", batteryEnd ?: JSONObject.NULL)

  companion object {
    fun fromJson(json: JSONObject): Recording {
      val marks = json.optJSONArray("marks") ?: JSONArray()
      return Recording(
        id = json.getString("id"),
        createdAt = json.getLong("createdAt"),
        mime = json.getString("mime"),
        fileName = json.getString("fileName"),
        state = json.getString("state"),
        durationMs = json.optLong("durationMs", 0),
        marks = (0 until marks.length()).map { marks.getLong(it) },
        recovered = json.optBoolean("recovered", false),
        batteryStart = if (json.isNull("batteryStart")) null else json.optInt("batteryStart"),
        batteryEnd = if (json.isNull("batteryEnd")) null else json.optInt("batteryEnd"),
      )
    }
  }
}

object RecordingStore {
  private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

  fun isValidId(id: String) = UUID.matches(id)

  fun root(context: Context): File = File(context.filesDir, "recordings").apply { mkdirs() }

  fun folder(context: Context, id: String): File {
    require(isValidId(id)) { "not a recording id" }
    return File(root(context), id)
  }

  fun audioFile(context: Context, recording: Recording): File = File(folder(context, recording.id), recording.fileName)

  /** Writes meta.json through a temporary file and a rename, so a crash never leaves half a file. */
  fun save(context: Context, recording: Recording) {
    val folder = folder(context, recording.id).apply { mkdirs() }
    val temp = File(folder, "meta.json.tmp")
    temp.writeText(recording.toJson().toString())
    if (!temp.renameTo(File(folder, "meta.json"))) {
      File(folder, "meta.json").delete()
      temp.renameTo(File(folder, "meta.json"))
    }
  }

  fun load(context: Context, id: String): Recording? = try {
    val file = File(folder(context, id), "meta.json")
    if (file.isFile) Recording.fromJson(JSONObject(file.readText())) else null
  } catch (_: Exception) {
    null
  }

  fun all(context: Context): List<Recording> =
    root(context).listFiles().orEmpty().filter { it.isDirectory && isValidId(it.name) }.mapNotNull { load(context, it.name) }

  fun delete(context: Context, id: String) {
    folder(context, id).deleteRecursively()
  }

  /**
   * Recordings left "recording" or "paused" by a process that died (killed, crashed, battery out). Each becomes a
   * finished, recovered note if its file has any audio, and is removed otherwise. Call only when no recording is live.
   */
  fun finaliseOrphans(context: Context) {
    for (recording in all(context)) {
      if (recording.state == "done") continue
      val audio = audioFile(context, recording)
      if (!audio.isFile || audio.length() == 0L) {
        delete(context, recording.id)
      } else {
        save(context, recording.copy(state = "done", recovered = true))
      }
    }
  }
}
