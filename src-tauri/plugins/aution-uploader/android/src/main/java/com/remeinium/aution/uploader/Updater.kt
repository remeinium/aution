// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The FileProvider that hands a downloaded update to Android's installer (its own class, so it never clashes with another). */
class UpdateFileProvider : FileProvider()

/**
 * The in-app update: downloads the APK of a newer GitHub release and opens Android's installer. Only release downloads
 * of this project's repository are accepted, the file must be this app, signed with the same key as the installed one,
 * and Android's installer checks the signature again before it replaces anything.
 */
object Updater {
  const val ALLOWED_PREFIX = "https://github.com/remeinium/aution/releases/download/"
  private val VERSION = Regex("^[0-9]+\\.[0-9]+\\.[0-9]+$")

  fun isAllowed(url: String, version: String) = url.startsWith(ALLOWED_PREFIX) && !url.contains("..") && VERSION.matches(version)

  private fun folder(context: Context) = File(context.cacheDir, "updates").apply { mkdirs() }

  /** Downloads (or reuses an earlier complete download), calling [progress] with each whole percent. */
  fun download(context: Context, url: String, version: String, progress: (Int) -> Unit): File {
    val target = File(folder(context), "aution-$version.apk")
    if (target.isFile && isOurs(context, target, version)) return target
    folder(context).listFiles().orEmpty().forEach { it.delete() } // older downloads
    val part = File(folder(context), "aution-$version.apk.part")
    var connection: HttpURLConnection? = null
    try {
      connection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 30_000
        readTimeout = 60_000
        instanceFollowRedirects = true // GitHub answers with a redirect to its file storage (https to https)
      }
      if (connection.responseCode != 200) throw IOException("The download answered ${connection.responseCode}.")
      val total = connection.contentLengthLong
      var done = 0L
      var shown = -1
      connection.inputStream.use { input ->
        part.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            done += read
            if (total > 0) {
              val percent = ((done * 100) / total).toInt().coerceIn(0, 100)
              if (percent != shown) { shown = percent; progress(percent) }
            }
          }
        }
      }
      if (total > 0 && done != total) throw IOException("The download stopped early.")
      if (!part.renameTo(target)) throw IOException("Could not save the download.")
    } finally {
      connection?.disconnect()
      part.delete()
    }
    if (!isOurs(context, target, version)) {
      target.delete()
      throw IOException("The downloaded file is not this app, or not signed by its publisher.")
    }
    return target
  }

  /** The same package, the expected version, and the same signing certificate as the installed app. */
  private fun isOurs(context: Context, apk: File, version: String): Boolean {
    val pm = context.packageManager
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
    val archive = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) pm.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(flags.toLong()))
      else @Suppress("DEPRECATION") pm.getPackageArchiveInfo(apk.path, flags)) ?: return false
    if (archive.packageName != context.packageName || archive.versionName != version) return false
    val installed = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
      else @Suppress("DEPRECATION") pm.getPackageInfo(context.packageName, flags))
    return signatures(archive) == signatures(installed) && signatures(installed).isNotEmpty()
  }

  private fun signatures(info: PackageInfo): Set<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners.orEmpty().map { it.toCharsString() }.toSet()
    else @Suppress("DEPRECATION") info.signatures.orEmpty().map { it.toCharsString() }.toSet()

  /** True when Android lets this app open the installer; otherwise it opens the screen where the person allows it. */
  fun canInstall(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()) return true
    context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    return false
  }

  fun install(context: Context, apk: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
    context.startActivity(Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
