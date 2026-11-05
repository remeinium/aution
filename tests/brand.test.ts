// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND } from '../src/brand'

const tauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { productName: string; identifier: string; app: { windows: { title: string }[] } }

describe('brand', () => {
  it('the native app uses the same name and id as src/brand.ts', () => {
    expect(tauri.productName).toBe(BRAND.name)
    expect(tauri.identifier).toBe(BRAND.appId)
    expect(tauri.app.windows.every(window => window.title === BRAND.name)).toBe(true)
  })

  it('the application id is a valid Android package name', () => {
    // Lowercase segments that start with a letter; at least two segments. Android also forbids Java keywords.
    expect(BRAND.appId).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  })

  it('the website is https', () => {
    expect(BRAND.website.startsWith('https://')).toBe(true)
  })
})
