// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Where to upload and when. WorkManager keeps the scheduled work across app restarts and reboots, and starts it only
 * when there is a connection (an unmetered one, with "Wi-Fi only").
 *
 * Two unique work names: [NOW] for "send what is waiting" (appended, so a request made while an upload runs is never
 * lost), and [LATER] for the next retry after a failure (replaced, there is only ever one next retry).
 */
object Uploads {
  const val TOKEN = "device-token"
  private const val NOW = "aution-upload"
  private const val LATER = "aution-upload-later"
  private const val PREFS = "aution-uploader"

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun endpoint(context: Context): String = prefs(context).getString("endpoint", "") ?: ""
  fun wifiOnly(context: Context): Boolean = prefs(context).getBoolean("wifiOnly", false)

  /** Saves the settings the worker needs. A change of the network rule cancels work queued under the old one. */
  fun configure(context: Context, endpoint: String, wifiOnly: Boolean) {
    val changed = wifiOnly != wifiOnly(context)
    prefs(context).edit().putString("endpoint", endpoint).putBoolean("wifiOnly", wifiOnly).apply()
    if (changed) {
      val manager = WorkManager.getInstance(context)
      manager.cancelUniqueWork(NOW)
      manager.cancelUniqueWork(LATER)
    }
  }

  private fun request(context: Context, delayMs: Long): OneTimeWorkRequest {
    val network = if (wifiOnly(context)) NetworkType.UNMETERED else NetworkType.CONNECTED
    return OneTimeWorkRequest.Builder(UploadWorker::class.java)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
      .setInitialDelay(delayMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
      .build()
  }

  fun runNow(context: Context) {
    WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, request(context, 0))
  }

  fun runAt(context: Context, at: Long) {
    WorkManager.getInstance(context).enqueueUniqueWork(LATER, ExistingWorkPolicy.REPLACE, request(context, at - System.currentTimeMillis()))
  }

  /** What the uploads are waiting for right now: "network", "wifi", or null when they can go. */
  fun waitingFor(context: Context): String? {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "network"
    if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "network"
    if (wifiOnly(context) && !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) return "wifi"
    return null
  }
}
