// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * One note waiting to be sent: `filesDir/outbox/<id>/audio` (a copy the UI handed over) and `entry.json` (the upload
 * form's metadata plus where the upload stands). App-private storage, excluded from backups.
 *
 * The UI keeps its own copy of the audio until it has seen `done` here, so this folder may be deleted at any time
 * without losing a note: the UI simply hands the note over again.
 */
data class Entry(
  val id: String,
  /** The `meta` part of the upload form, exactly as the UI built it (JSON text). */
  val meta: String,
  val mime: String,
  val fileName: String,
  /** When the UI handed it over; oldest goes first. */
  val queuedAt: Long,
  /** "waiting", "uploading", "done" or "failed" (the server refused it for good; the person can retry). */
  val state: String,
  val attempts: Int,
  val lastError: String?,
  /** Not before this moment (ms since epoch); 0 means as soon as there is a connection. */
  val nextAttemptAt: Long,
  val uploadedAt: Long?,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("id", id).put("meta", meta).put("mime", mime).put("fileName", fileName).put("queuedAt", queuedAt)
    .put("state", state).put("attempts", attempts).put("lastError", lastError ?: JSONObject.NULL)
    .put("nextAttemptAt", nextAttemptAt).put("uploadedAt", uploadedAt ?: JSONObject.NULL)

  companion object {
    fun fromJson(json: JSONObject) = Entry(
      id = json.getString("id"),
      meta = json.getString("meta"),
      mime = json.getString("mime"),
      fileName = json.getString("fileName"),
      queuedAt = json.optLong("queuedAt", 0),
      state = json.optString("state", "waiting"),
      attempts = json.optInt("attempts", 0),
      lastError = if (json.isNull("lastError")) null else json.optString("lastError"),
      nextAttemptAt = json.optLong("nextAttemptAt", 0),
      uploadedAt = if (json.isNull("uploadedAt")) null else json.optLong("uploadedAt"),
    )
  }
}

/** Every change goes through these synchronized functions: the worker and the UI's commands run on different threads. */
object Outbox {
  private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

  fun isValidId(id: String) = UUID.matches(id)

  fun root(context: Context): File = File(context.filesDir, "outbox").apply { mkdirs() }

  private fun folder(context: Context, id: String): File {
    require(isValidId(id)) { "not a note id" }
    return File(root(context), id)
  }

  fun audio(context: Context, id: String): File = File(folder(context, id), "audio")

  /** Where [UploaderPlugin.stage] collects the pieces; renamed to [audio] when complete. */
  fun part(context: Context, id: String): File = File(folder(context, id).apply { mkdirs() }, "audio.part")

  /**
   * Moves the audio of a finished native recording (aution-recorder keeps it in `filesDir/recordings/<id>/audio.ogg`
   * or `audio.aac`) into this outbox, then removes the recording's folder. A rename within the app's own storage: no
   * copy. Returns false when there is no such recording.
   */
  @Synchronized
  fun adoptRecording(context: Context, id: String): Boolean {
    val recording = File(File(context.filesDir, "recordings"), folder(context, id).name)
    val source = listOf("audio.ogg", "audio.aac").map { File(recording, it) }.firstOrNull { it.isFile } ?: return false
    val target = audio(context, id)
    target.parentFile?.mkdirs()
    if (!target.isFile && !source.renameTo(target)) return false
    recording.deleteRecursively()
    return true
  }

  /** Notes whose audio is in the outbox but which have not been handed over yet (upload off, or not connected). */
  @Synchronized
  fun stagedOnly(context: Context): List<String> =
    root(context).listFiles().orEmpty()
      .filter { it.isDirectory && isValidId(it.name) && File(it, "audio").isFile && !File(it, "entry.json").isFile }
      .map { it.name }

  @Synchronized
  fun load(context: Context, id: String): Entry? = try {
    val file = File(folder(context, id), "entry.json")
    if (file.isFile) Entry.fromJson(JSONObject(file.readText())) else null
  } catch (_: Exception) {
    null
  }

  @Synchronized
  fun all(context: Context): List<Entry> =
    root(context).listFiles().orEmpty().filter { it.isDirectory && isValidId(it.name) }.mapNotNull { load(context, it.name) }

  /** Writes through a temporary file and a rename, so a crash never leaves half a file. Does nothing for a forgotten note. */
  private fun save(context: Context, entry: Entry) {
    val folder = folder(context, entry.id)
    if (!folder.isDirectory) return
    val temp = File(folder, "entry.json.tmp")
    temp.writeText(entry.toJson().toString())
    if (!temp.renameTo(File(folder, "entry.json"))) {
      File(folder, "entry.json").delete()
      temp.renameTo(File(folder, "entry.json"))
    }
  }

  /**
   * Adds a note whose audio is already staged, or refreshes the metadata of one that is still waiting (a rename made
   * before the upload). A note being sent or already sent keeps its state.
   */
  @Synchronized
  fun put(context: Context, id: String, meta: String, mime: String, fileName: String): Boolean {
    if (!audio(context, id).isFile) return false
    val current = load(context, id)
    val next = when {
      current == null -> Entry(id, meta, mime, fileName, System.currentTimeMillis(), "waiting", 0, null, 0, null)
      current.state == "waiting" || current.state == "failed" -> current.copy(meta = meta, mime = mime, fileName = fileName)
      else -> return true
    }
    save(context, next)
    return true
  }

  /** Applies [change] to the stored entry, if it still exists. Returns the new entry. */
  @Synchronized
  fun update(context: Context, id: String, change: (Entry) -> Entry): Entry? {
    val current = load(context, id) ?: return null
    val next = change(current)
    save(context, next)
    return next
  }

  @Synchronized
  fun forget(context: Context, id: String) {
    folder(context, id).deleteRecursively()
  }
}
