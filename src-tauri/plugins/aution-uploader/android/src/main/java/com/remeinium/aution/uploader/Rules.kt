// SPDX-License-Identifier: AGPL-3.0-only
package com.remeinium.aution.uploader

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Upload rules, the same as the UI's src/lib/rules.ts (and public/sw.js). Change all three together:
 * which answers mean done / try again / give up, how long to wait, and what to tell the person.
 */
object Rules {
  enum class Outcome { OK, RETRY, PERMANENT }

  fun classify(status: Int): Outcome = when {
    status in 200..299 -> Outcome.OK
    status == 409 -> Outcome.OK // the server already holds this note id, which is what we wanted
    status == 408 || status == 425 || status == 429 || status >= 500 -> Outcome.RETRY
    else -> Outcome.PERMANENT
  }

  fun retryDelayMs(attempts: Int, random: Double = Math.random(), retryAfterSeconds: Long = 0): Long {
    val base = min(15 * 60_000.0, 5_000.0 * Math.pow(2.0, max(0, attempts - 1).toDouble()))
    val delay = (base * (0.8 + random * 0.4)).roundToLong()
    return if (retryAfterSeconds > 0) max(delay, min(retryAfterSeconds, 3600) * 1000) else delay
  }

  /** A minute plus a second per 10 KB, with no upper cap: a long recording is never cut off for its size. */
  fun uploadTimeoutMs(size: Long): Long = 60_000L + ((size + 9_999) / 10_000) * 1000

  fun statusMessage(status: Int): String = when {
    status == 401 || status == 403 -> "The server rejected the access token."
    status == 404 -> "The upload address was not found on the server."
    status == 413 -> "The server says this recording is too large."
    status == 415 || status == 422 -> "The server could not accept this audio format."
    status == 429 -> "The server asked us to slow down."
    status >= 500 -> "The server had a problem ($status)."
    else -> "The server answered $status."
  }
}
