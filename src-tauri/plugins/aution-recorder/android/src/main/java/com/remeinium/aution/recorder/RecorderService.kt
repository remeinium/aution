// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.recorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File
import kotlin.math.min
import kotlin.math.sqrt

/** What the service tells the plugin (and through it the UI). Always called on the main thread. */
interface RecorderListener {
  fun onState(service: RecorderService)
  fun onLevel(level: Float)
  fun onWarning(message: String?)
  fun onFinished(recording: Recording)
  fun onFailed(message: String)
}

/**
 * Records one note at a time in a foreground service of type microphone. That type is what lets Android keep giving
 * the app real audio with the screen off or another app in front (a WebView gets silence then). The notification shows
 * the running time and has Pause/Resume and Stop.
 */
class RecorderService : Service() {
  companion object {
    private const val TAG = "AutionRecorder"
    const val ACTION_START = "com.remeinium.aution.recorder.START"
    const val ACTION_PAUSE = "com.remeinium.aution.recorder.PAUSE"
    const val ACTION_RESUME = "com.remeinium.aution.recorder.RESUME"
    const val ACTION_STOP = "com.remeinium.aution.recorder.STOP"
    const val EXTRA_ID = "id"
    const val EXTRA_BITRATE = "bitrate"
    private const val CHANNEL = "recording"
    private const val NOTIFICATION_ID = 7301
    private const val LEVEL_MS = 70L
    private const val SAVE_MS = 1000L

    /** The running service, if any. The plugin and the service live in the same process. */
    @Volatile var current: RecorderService? = null
      private set

    var listener: RecorderListener? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private var recorder: MediaRecorder? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null

  private var id: String = ""
  private var createdAt = 0L
  private var mime = ""
  private var fileName = ""
  private var batteryStart: Int? = null
  private var startedRealtime = 0L
  private var pausedTotal = 0L
  private var pausedAt = 0L
  private val marks = mutableListOf<Long>()

  val recordingId: String get() = id
  var state: String = "idle"
    private set

  fun elapsedMs(): Long {
    if (state != "recording" && state != "paused") return 0
    val end = if (state == "paused") pausedAt else SystemClock.elapsedRealtime()
    return (end - startedRealtime - pausedTotal).coerceAtLeast(0)
  }

  fun markCount(): Int = marks.size

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    current = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> begin(intent.getStringExtra(EXTRA_ID) ?: "", intent.getIntExtra(EXTRA_BITRATE, 32000))
      ACTION_PAUSE -> pause()
      ACTION_RESUME -> resume()
      ACTION_STOP -> stopAndSave()
      else -> {
        // Restarted by the system after the process died: the recorder is gone and Android does not let a
        // background service open the microphone again. Keep what was recorded and stop.
        RecordingStore.finaliseOrphans(this)
        stopSelf()
      }
    }
    // Never restart on our own: a recording must only start from a tap.
    return START_NOT_STICKY
  }

  private fun begin(newId: String, bitrate: Int) {
    if (state != "idle") return
    // Android requires startForeground within seconds of startForegroundService, even when we are about to give up,
    // and before the microphone is opened.
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } catch (error: Exception) {
      fail("Android did not allow recording in the background: ${error.message}")
      return
    }
    if (!RecordingStore.isValidId(newId)) { fail("Not a valid recording id."); return }
    RecordingStore.finaliseOrphans(this) // anything left by an earlier crash is kept, not overwritten

    id = newId
    createdAt = System.currentTimeMillis()
    marks.clear()
    pausedTotal = 0
    batteryStart = battery()
    val folder = RecordingStore.folder(this, id).apply { mkdirs() }

    val opened = openRecorder(folder, bitrate.coerceIn(16000, 256000))
    if (opened == null) {
      RecordingStore.delete(this, id)
      fail("The microphone could not be opened. Another app (or a call) may be using it.")
      return
    }
    recorder = opened
    startedRealtime = SystemClock.elapsedRealtime()
    state = "recording"
    save()
    acquireWakeLock()
    watchSilencing()
    main.postDelayed(levelTick, LEVEL_MS)
    main.postDelayed(saveTick, SAVE_MS)
    refreshNotification()
    listener?.onState(this)
  }

  /** Opus in Ogg (Android 10+), else AAC in ADTS. Both stay playable if the file is cut off mid-write. */
  private fun openRecorder(folder: File, bitrate: Int): MediaRecorder? {
    val formats = buildList {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(Triple("ogg", "audio/ogg", true))
      add(Triple("aac", "audio/aac", false))
    }
    for ((extension, type, opus) in formats) {
      val file = File(folder, "audio.$extension")
      val candidate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
      try {
        candidate.setAudioSource(MediaRecorder.AudioSource.MIC)
        if (opus) {
          candidate.setOutputFormat(MediaRecorder.OutputFormat.OGG)
          candidate.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
          candidate.setAudioSamplingRate(48000)
        } else {
          candidate.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
          candidate.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
          candidate.setAudioSamplingRate(44100)
        }
        candidate.setAudioChannels(1)
        candidate.setAudioEncodingBitRate(bitrate)
        candidate.setOutputFile(file.absolutePath)
        candidate.prepare()
        candidate.start()
        mime = type
        fileName = file.name
        return candidate
      } catch (error: Exception) {
        Log.w(TAG, "could not record $type: ${error.message}")
        candidate.release()
        file.delete()
      }
    }
    return null
  }

  fun pause() {
    val active = recorder ?: return
    if (state != "recording") return
    try { active.pause() } catch (error: Exception) { Log.w(TAG, "pause failed: ${error.message}"); return }
    pausedAt = SystemClock.elapsedRealtime()
    state = "paused"
    save()
    refreshNotification()
    listener?.onState(this)
  }

  fun resume() {
    val active = recorder ?: return
    if (state != "paused") return
    try { active.resume() } catch (error: Exception) { Log.w(TAG, "resume failed: ${error.message}"); return }
    pausedTotal += SystemClock.elapsedRealtime() - pausedAt
    state = "recording"
    save()
    refreshNotification()
    listener?.onState(this)
  }

  /** Marks the current moment. Returns how many moments are marked. */
  fun mark(): Int {
    if (state == "recording" || state == "paused") {
      marks.add(elapsedMs())
      save()
    }
    return marks.size
  }

  /** Stops, closes the file and returns the finished recording (null when nothing was recorded). */
  fun stopAndSave(): Recording? {
    val active = recorder ?: run { stopSelf(); return null }
    val durationMs = elapsedMs()
    main.removeCallbacks(levelTick)
    main.removeCallbacks(saveTick)
    var ok = true
    try { active.stop() } catch (error: RuntimeException) {
      // MediaRecorder throws when it got no audio at all (stopped within a moment of starting).
      Log.w(TAG, "stop: ${error.message}")
      ok = false
    }
    active.release()
    recorder = null
    stopWatchingSilencing()
    releaseWakeLock()
    state = "idle"

    val finished = Recording(id, createdAt, mime, fileName, "done", durationMs, marks.toList(), false, batteryStart, battery())
    val audio = RecordingStore.audioFile(this, finished)
    val result = if (ok && audio.isFile && audio.length() > 0) {
      RecordingStore.save(this, finished)
      finished
    } else {
      RecordingStore.delete(this, id)
      null
    }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
    listener?.onState(this)
    if (result != null) listener?.onFinished(result)
    return result
  }

  override fun onDestroy() {
    // The system is taking the service down while recording (rare for a foreground service): keep the audio.
    if (recorder != null) stopAndSave()
    current = null
    super.onDestroy()
  }

  private fun fail(message: String) {
    Log.w(TAG, message)
    state = "idle"
    try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
    stopSelf()
    listener?.onFailed(message)
  }

  /** Also stores the battery now, so a recording recovered after the process was killed still has an end reading. */
  private fun save() {
    if (id.isEmpty() || state == "idle") return
    RecordingStore.save(this, Recording(id, createdAt, mime, fileName, state, elapsedMs(), marks.toList(), false, batteryStart, battery()))
  }

  private val saveTick = object : Runnable {
    override fun run() {
      save()
      main.postDelayed(this, SAVE_MS)
    }
  }

  private val levelTick = object : Runnable {
    override fun run() {
      val active = recorder
      if (active != null && state == "recording") {
        // maxAmplitude is the peak since the last call, 0..32767. The square root spreads quiet speech out.
        val amplitude = try { active.maxAmplitude } catch (_: Exception) { 0 }
        listener?.onLevel(min(1f, sqrt(amplitude / 32767f) * 1.2f))
      }
      if (active != null) main.postDelayed(this, LEVEL_MS)
    }
  }

  /** Android 10+ says when the system silences our capture, for example during a phone call. */
  private fun watchSilencing() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    var silenced = false
    val callback = object : AudioManager.AudioRecordingCallback() {
      override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
        // An ordinary app only ever sees its own recordings here.
        val now = configs.any { it.isClientSilenced }
        if (now == silenced) return
        silenced = now
        listener?.onWarning(if (now) "Another app or a call is using the microphone. This part will be silent." else null)
        refreshNotification(if (now) "Microphone in use by a call" else null)
      }
    }
    audio.registerAudioRecordingCallback(callback, main)
    recordingCallback = callback
  }

  private fun stopWatchingSilencing() {
    val callback = recordingCallback ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) (getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioRecordingCallback(callback)
    recordingCallback = null
  }

  private fun acquireWakeLock() {
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aution:recording").apply {
      setReferenceCounted(false)
      acquire(6 * 60 * 60 * 1000L) // a safety limit; released on stop
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun battery(): Int? {
    val manager = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val percent = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    return if (percent in 0..100) percent else null
  }

  private fun refreshNotification(note: String? = null) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, notification(note))
  }

  private fun notification(note: String? = null): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while a voice note is being recorded"
        setShowBadge(false)
      })
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP }
    val action = { name: String, code: Int ->
      PendingIntent.getService(this, code, Intent(this, RecorderService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val paused = state == "paused"
    val appName = applicationInfo.loadLabel(packageManager).toString()
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(if (paused) "Paused" else "Recording")
      .setContentText(note ?: if (paused) "Tap Resume to carry on, or Stop to save." else "$appName keeps recording with the screen off.")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setUsesChronometer(!paused && state == "recording")
      .setWhen(System.currentTimeMillis() - elapsedMs())
      .setShowWhen(state == "recording")
      .apply { if (open != null) setContentIntent(PendingIntent.getActivity(this@RecorderService, 1, open, PendingIntent.FLAG_IMMUTABLE)) }
      .apply {
        if (state == "recording") addAction(0, "Pause", action(ACTION_PAUSE, 2))
        if (paused) addAction(0, "Resume", action(ACTION_RESUME, 3))
      }
      .addAction(0, "Stop", action(ACTION_STOP, 4))
      .build()
  }
}
