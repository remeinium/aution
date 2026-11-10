// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
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
    /** Uploads at least this big run in the foreground (see [goForeground]). */
    private const val FOREGROUND_BYTES = 2L * 1024 * 1024
    private const val CHANNEL = "uploads"
    private const val NOTIFICATION_ID = 7302
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
    // A retry of an upload that went through but whose answer was lost (the connection dropped after the server had
    // it all): ask first instead of sending a long recording again. A server without this question answers 404.
    if (entry.attempts > 0 || audio.length() >= FOREGROUND_BYTES) {
      if (alreadyStored(endpoint, token, entry.id)) {
        Outbox.update(context, entry.id) { it.copy(state = "done", uploadedAt = System.currentTimeMillis(), lastError = null, nextAttemptAt = 0) }
        audio.delete()
        return
      }
    }
    val attempts = entry.attempts + 1
    Outbox.update(context, entry.id) { it.copy(state = "uploading", attempts = attempts, progress = 0) } ?: return
    UploaderPlugin.changed()
    val foreground = audio.length() >= FOREGROUND_BYTES && goForeground(audio.length())

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
          val total = audio.length().coerceAtLeast(1)
          var sent = 0L
          var shown = 0
          var shownAt = 0L
          while (true) {
            if (isStopped) throw IOException("stopped")
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            sent += read
            // Each whole percent, at most twice a second: the library shows it, and so does the notification.
            val percent = ((sent * 100) / total).toInt().coerceIn(0, 99)
            val now = System.currentTimeMillis()
            if (percent > shown && now - shownAt >= 500) {
              shown = percent
              shownAt = now
              Outbox.update(context, entry.id) { it.copy(progress = percent) }
              UploaderPlugin.changed()
              if (foreground) showProgress(audio.length(), percent)
            }
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

  /** `GET /v1/notes/<id>`: 200 when the server already stores this note. Any failure counts as "not stored". */
  private fun alreadyStored(endpoint: String, token: String, id: String): Boolean {
    var connection: HttpURLConnection? = null
    return try {
      connection = (URL("$endpoint/v1/notes/$id").openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 15_000
        setRequestProperty("Authorization", "Bearer $token")
      }
      connection.responseCode == 200
    } catch (_: IOException) {
      false
    } finally {
      connection?.disconnect()
    }
  }

  /**
   * Turns this work into a foreground job with an "Uploading" notification, so Android neither stops it at the
   * 10-minute limit for background work nor freezes the app during a long upload. Android may refuse when the app is
   * not on screen (Android 12+); the upload then carries on as ordinary background work.
   */
  /** Returns true when Android let this work run in the foreground. */
  private fun goForeground(bytes: Long): Boolean = try {
    val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Uploads", NotificationManager.IMPORTANCE_LOW))
    }
    val notification = progressNotification(bytes, 0)
    val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else ForegroundInfo(NOTIFICATION_ID, notification)
    setForegroundAsync(info).get()
    true
  } catch (_: Exception) {
    false // not allowed right now: carry on in the background
  }

  private fun progressNotification(bytes: Long, percent: Int) = NotificationCompat.Builder(applicationContext, CHANNEL)
    .setSmallIcon(android.R.drawable.stat_sys_upload)
    .setContentTitle("Uploading a recording")
    .setContentText("%d%% of %.0f MB".format(percent, bytes / 1048576.0))
    .setOngoing(true)
    .setSilent(true)
    .setOnlyAlertOnce(true)
    .setProgress(100, percent, false)
    .build()

  private fun showProgress(bytes: Long, percent: Int) {
    try {
      val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION_ID, progressNotification(bytes, percent))
    } catch (_: Exception) {
    }
  }
}
