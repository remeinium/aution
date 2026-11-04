import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { BRAND } from './src/brand.ts'

/**
 * Fills the `@precache` and `@version` markers in dist/sw.js with the built file list so the
 * recorder opens offline from the first launch. Relative URLs keep the app movable (sub-path, Tauri).
 */
function serviceWorkerManifest(): Plugin {
  let outDir = 'dist'
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
  return {
    name: 'trapper-voice-sw-manifest',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir },
    closeBundle() {
      const files = walk(outDir).map(path => relative(outDir, path).split('\\').join('/')).filter(file => file !== 'sw.js' && !file.endsWith('.map'))
      const hash = createHash('sha256')
      for (const file of files.sort()) hash.update(file).update(readFileSync(join(outDir, file)))
      const swPath = join(outDir, 'sw.js')
      const source = readFileSync(swPath, 'utf8')
        .replace('[] /* @precache */', () => JSON.stringify(['./', ...files]))
        .replace("'dev' /* @version */", () => JSON.stringify(hash.digest('hex').slice(0, 12)))
      writeFileSync(swPath, source)
    },
  }
}

/** Puts the product name from src/brand.ts into index.html and the built web manifest, so a rename is one edit. */
function brand(): Plugin {
  let outDir = 'dist'
  return {
    name: 'brand',
    configResolved(config) { outDir = config.build.outDir },
    transformIndexHtml: { order: 'pre', handler: html => html.replaceAll('%BRAND_NAME%', BRAND.name).replaceAll('%BRAND_TAGLINE%', BRAND.tagline) },
    closeBundle() {
      const path = join(outDir, 'manifest.webmanifest')
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, `${JSON.stringify({ ...manifest, name: BRAND.name, short_name: BRAND.name }, null, 2)}\n`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), brand(), serviceWorkerManifest()],
  build: { target: 'es2023' },
})
