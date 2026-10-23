import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import productionFeatures from './production-features.json'

// Match the Pages proxy rules and nginx document fallbacks in local servers.
function readerDocument(request: IncomingMessage, _response: ServerResponse, next: () => void) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const match = /^\/(profile|discussion)\/[^/]+\/?$/.exec(url.pathname)
  const accepts = request.headers.accept
  if (match && (request.method === 'GET' || request.method === 'HEAD') &&
      (!accepts || accepts.includes('text/html') || accepts.includes('*/*'))) {
    request.url = `/${match[1]}.html${url.search}`
  }
  next()
}

const readerDocuments: Plugin = {
  name: 'holoboard-reader-documents',
  configureServer(server) { server.middlewares.use(readerDocument) },
  configurePreviewServer(server) { server.middlewares.use(readerDocument) },
}

function revision() {
  const supplied = process.env.CF_PAGES_COMMIT_SHA?.trim()
  if (supplied && /^[a-f0-9]{40}$/i.test(supplied)) return supplied
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Linked package development must share the application React dispatcher.
  resolve: { dedupe: ['react', 'react-dom'] },
  // Keep ordinary builds opt-in; pin the production Pages branch in Git.
  define: process.env.CF_PAGES === '1' && process.env.CF_PAGES_BRANCH === 'main'
    ? Object.fromEntries(Object.entries(productionFeatures)
        .map(([name, value]) => [`import.meta.env.${name}`, JSON.stringify(value)]))
    : undefined,
  plugins: [
    {
      name: 'holoboard-build-revision',
      apply: 'build',
      transformIndexHtml() {
        const commit = revision()
        return commit ? [{ tag: 'meta', attrs: { name: 'holoboard-revision', content: commit }, injectTo: 'head' }] : []
      },
    },
    react(),
    readerDocuments,
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'Holoboard',
        short_name: 'Holoboard',
        description: 'A pay-to-promote bulletin board on Nostr.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#05010d',
        theme_color: '#05010d',
        categories: ['social'],
        icons: [
          {
            src: '/icons/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        importScripts: ['preserve-assets.js'],
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
        globIgnores: ['og.png'],
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/relay(?:\/|$)/,
          /^\/\.well-known\//,
        ],
        runtimeCaching: [{
          // Precache routes win for the current build. Only obsolete immutable
          // modules reach this bounded archive; API responses never enter it.
          urlPattern: ({ url, sameOrigin }) => sameOrigin &&
              /^\/assets\/.+-[\w-]+\.(?:js|css|woff2?|svg|png|webp)$/.test(url.pathname),
          handler: 'CacheOnly',
          options: {
            cacheName: 'holoboard-previous-assets-v1',
            expiration: { maxEntries: 96, maxAgeSeconds: 24 * 60 * 60 },
          },
        }],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        waiting: fileURLToPath(new URL('./waiting.html', import.meta.url)),
        help: fileURLToPath(new URL('./help.html', import.meta.url)),
        expired: fileURLToPath(new URL('./expired.html', import.meta.url)),
        profile: fileURLToPath(new URL('./profile.html', import.meta.url)),
        discussion: fileURLToPath(new URL('./discussion.html', import.meta.url)),
      },
      treeshake: {
        /*
         * None of the nostr packages declare `sideEffects: false`, so rollup
         * keeps every module they import even when nothing references it. The
         * expensive case is @nostr-dev-kit/react, whose barrel statically pulls
         * in @nostr-dev-kit/wallet and @cashu/cashu-ts for hooks this app never
         * calls. Declaring those three trees side-effect free lets the unused
         * exports go, which is where roughly a third of the bundle went.
         */
        moduleSideEffects: (id) =>
            !/node_modules\/(@nostr-dev-kit\/(react|wallet|sync)|@cashu)\//.test(id),
      },
      output: {
        // Split the two heavy vendor trees out so a change to app code does
        // not force everyone to re-download React and NDK.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/nostr-tools\/lib\/esm\/nip46\.js$/.test(id)) return 'signer'
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (/node_modules\/(@nostr-dev-kit|nostr-tools|@noble|@scure|light-bolt11-decoder)\//.test(id))
            return 'nostr'
        },
      },
    },
  },
})
