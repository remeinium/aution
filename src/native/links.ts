// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pages outside the app (the server's approval page, the account page, Google Drive, ChatGPT) must open in the
 * system browser. Android's WebView does not open new windows, so inside the native app every `target="_blank"`
 * link and every `window.open` is handed to the browser instead. The UI code stays the same as on the web.
 */

/** The address to open outside the app, or null for anything that is not a plain web page (file:, intent:, javascript:). */
export function externalUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null
  try {
    const url = new URL(href, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Stands in for the window `window.open` would return. ConnectCard opens a blank window inside the tap and sets its
 * address once the server has answered; here setting the address opens the browser.
 */
export function browserWindowStub(open: (url: string) => void): Window {
  let closed = false
  const location = { set href(value: string) { const url = externalUrl(value, window.location.href); if (url) open(url) }, get href() { return 'about:blank' } }
  return { location, close() { closed = true }, get closed() { return closed } } as unknown as Window
}

export function routeExternalLinks(open: (url: string) => void): void {
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor || anchor.target !== '_blank') return
    const url = externalUrl(anchor.getAttribute('href'), window.location.href)
    if (!url) return
    event.preventDefault()
    open(url)
  }, true)

  window.open = ((target?: string | URL) => {
    const url = target ? externalUrl(String(target), window.location.href) : null
    if (url) open(url)
    return browserWindowStub(open)
  }) as typeof window.open
}
