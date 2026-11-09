// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (the device token), encrypted with AES-256-GCM under a key that lives in the Android Keystore and
 * never leaves it. Only the ciphertext is stored, in this app's private preferences (not backed up:
 * allowBackup=false). No user authentication is required, so the background uploader can read the token while the
 * phone is locked. Nothing here is ever logged.
 */
object Secrets {
  private const val KEY_ALIAS = "aution-secrets"
  private const val PREFS = "aution-secrets"
  private const val IV_BYTES = 12
  private val NAME = Regex("^[a-z][a-z0-9-]{0,39}$")

  fun isValidName(name: String) = NAME.matches(name)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** The secret, or null when there is none or it can no longer be decrypted (for example after the key was reset). */
  @Synchronized
  fun get(context: Context, name: String): String? {
    require(isValidName(name))
    val stored = prefs(context).getString(name, null) ?: return null
    return try {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
      String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    } catch (_: Exception) {
      null
    }
  }

  /** Throws if the Keystore refuses; the caller then keeps the secret where it was. */
  @Synchronized
  fun set(context: Context, name: String, value: String) {
    require(isValidName(name))
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    if (!prefs(context).edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
      throw IllegalStateException("could not save the secret")
    }
  }

  @Synchronized
  fun remove(context: Context, name: String) {
    require(isValidName(name))
    prefs(context).edit().remove(name).commit()
  }
}
