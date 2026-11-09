// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings

/**
 * Xiaomi's "Autostart" switch (MIUI / HyperOS). With it off, a closed app is not started for its scheduled background
 * work: measured on a Redmi Note 14 (HyperOS 3.0), the upload job was refused with "process is bad" when the network
 * came back. There is no permission dialog for it; the best an app can do is open the screen with the switch.
 */
object Background {
  /** MIUI's private app-op for Autostart. */
  private const val OP_AUTOSTART = 10008

  fun hasAutostartSwitch(): Boolean =
    listOf("xiaomi", "redmi", "poco").any { Build.MANUFACTURER.equals(it, ignoreCase = true) || Build.BRAND.equals(it, ignoreCase = true) }

  /** True / false when the phone says; null when it cannot tell (not a Xiaomi phone, or the check is blocked). */
  fun autostartAllowed(context: Context): Boolean? {
    if (!hasAutostartSwitch()) return null
    return try {
      val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
      val check = AppOpsManager::class.java.getMethod("checkOpNoThrow", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java)
      (check.invoke(ops, OP_AUTOSTART, Process.myUid(), context.packageName) as Int) == AppOpsManager.MODE_ALLOWED
    } catch (_: Exception) {
      null
    }
  }

  /** Opens Xiaomi's Autostart list, or else this app's system settings page. */
  fun openAutostartSettings(context: Context): Boolean {
    val autostart = Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
    val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
    for (intent in listOf(autostart, details)) {
      try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
      } catch (_: Exception) {
      }
    }
    return false
  }
}
