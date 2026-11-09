// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock

/**
 * Sends the waiting notes in the outbox, oldest first, one at a time, with the same request as the UI's uploader:
 * `POST /v1/notes`, multipart `meta` + `audio`, the device token, and the note id as `Idempotency-Key` (so a retry of
 * an upload the server already finished is answered 409 and counts as done).
 *
 * After a failure that may pass (no connection, 5xx, 429) the note waits with backoff, honouring Retry-After, and the
 * next run is scheduled for when the first one is due. A refusal (4xx) marks it failed; the person can retry it.
 */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  companion object {
    /** One upload pass at a time in this process: the "now" and the "later" work may start together. */
    private val running = ReentrantLock()
  }

  override fun doWork(): Result {
    running.lock()
    try {
      pass()
    } finally {
      running.unlock()
      UploaderPlugin.changed()
    }
    return Result.success()
  }

  private fun pass() {
    val context = applicationContext
    // Left "uploading" by a pass that was stopped (time limit, lost network, killed process): we hold the lock now.
    for (entry in Outbox.all(context)) if (entry.state == "uploading") Outbox.update(context, entry.id) { it.copy(state = "waiting") }

    val endpoint = Uploads.endpoint(context).trimEnd('/')
    val token = Secrets.get(context, Uploads.TOKEN)
    if (endpoint.isEmpty() || token.isNullOrEmpty()) {
      // Not connected to a server: nothing can go. Connecting kicks the uploads again.
      for (entry in Outbox.all(context)) if (entry.state == "waiting") Outbox.update(context, entry.id) { it.copy(lastError = "Not connected to a server yet.") }
      return
    }

    val tried = HashSet<String>()
    while (!isStopped) {
      val now = System.currentTimeMillis()
      val next = Outbox.all(context)
        .filter { it.state == "waiting" && it.nextAttemptAt <= now && it.id !in tried }
        .minByOrNull { it.queuedAt } ?: break
      tried.add(next.id)
      send(next, endpoint, token)
    }
    if (isStopped) return // WorkManager runs this work again when it can

    val due = Outbox.all(context).filter { it.state == "waiting" }.minOfOrNull { it.nextAttemptAt }
    if (due != null) Uploads.runAt(context, due)
  }

  private fun send(entry: Entry, endpoint: String, token: String) {
    val context = applicationContext
    val audio = Outbox.audio(context, entry.id)
    if (!audio.isFile) {
      // The UI still holds the audio; it hands the note over again when it next opens.
      Outbox.forget(context, entry.id)
      return
    }
    val attempts = entry.attempts + 1
    Outbox.update(context, entry.id) { it.copy(state = "uploading", attempts = attempts) } ?: return
    UploaderPlugin.changed()

    val boundary = "aution-" + UUID.randomUUID()
    val head = ("--$boundary\r\nContent-Disposition: form-data; name=\"meta\"\r\n\r\n" + entry.meta + "\r\n" +
      "--$boundary\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"${entry.fileName}\"\r\n" +
      "Content-Type: ${entry.mime}\r\n\r\n").toByteArray(Charsets.UTF_8)
    val tail = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)

    var connection: HttpURLConnection? = null
    try {
      connection = (URL("$endpoint/v1/notes").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        doOutput = true
        connectTimeout = 30_000
        readTimeout = Rules.uploadTimeoutMs(audio.length()).toInt()
        setFixedLengthStreamingMode(head.size + audio.length() + tail.size)
        setRequestProperty("Authorization", "Bearer $token")
        setRequestProperty("Idempotency-Key", entry.id)
        setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
      }
      connection.outputStream.use { out ->
        out.write(head)
        audio.inputStream().use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            if (isStopped) throw IOException("stopped")
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
          }
        }
        out.write(tail)
      }
      val status = connection.responseCode
      val retryAfter = connection.getHeaderField("Retry-After")?.trim()?.toLongOrNull() ?: 0
      when (Rules.classify(status)) {
        Rules.Outcome.OK -> {
          Outbox.update(context, entry.id) { it.copy(state = "done", uploadedAt = System.currentTimeMillis(), lastError = null, nextAttemptAt = 0) }
          audio.delete() // the server has it and the UI keeps its own copy; only the small entry stays until the UI has seen it
        }
        Rules.Outcome.RETRY -> Outbox.update(context, entry.id) {
          it.copy(state = "waiting", lastError = Rules.statusMessage(status), nextAttemptAt = System.currentTimeMillis() + Rules.retryDelayMs(attempts, retryAfterSeconds = retryAfter))
        }
        Rules.Outcome.PERMANENT -> Outbox.update(context, entry.id) { it.copy(state = "failed", lastError = Rules.statusMessage(status), nextAttemptAt = 0) }
      }
    } catch (error: IOException) {
      val message = when {
        isStopped -> null // not a failure: Android paused the work, it carries on later
        error is SocketTimeoutException -> "The upload took too long."
        else -> "No connection to the server."
      }
      Outbox.update(context, entry.id) {
        if (message == null) it.copy(state = "waiting", attempts = entry.attempts)
        else it.copy(state = "waiting", lastError = message, nextAttemptAt = System.currentTimeMillis() + Rules.retryDelayMs(attempts))
      }
    } finally {
      connection?.disconnect()
    }
  }
}
