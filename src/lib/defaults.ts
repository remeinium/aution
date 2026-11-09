/**
 * The server a new device offers to connect to. Change it for a different deployment, or set VITE_DEFAULT_SERVER
 * when building. It is only a suggestion: nothing is stored until the device has actually been approved.
 */
export const DEFAULT_SERVER: string = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || 'https://aution.remeinium.com'

/**
 * Where the website's "Download the Android app" link points (Settings; hidden inside the app itself). Set
 * VITE_APK_URL at build time to change it, or to an empty value to hide the link. The default always serves the
 * newest signed APK attached to a GitHub release (.github/workflows/android.yml).
 */
export const APK_URL: string = (import.meta.env.VITE_APK_URL as string | undefined) ?? 'https://github.com/remeinium/aution/releases/latest/download/aution.apk'
