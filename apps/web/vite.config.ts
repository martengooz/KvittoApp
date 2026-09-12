import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** One year, in seconds — used for the immutable vendor bundle. */
const ONE_YEAR = 60 * 60 * 24 * 365;

export default defineConfig({
  resolve: {
    alias: {
      // Point at the shared package's source so `vite dev` picks up edits
      // without a rebuild, and so tree-shaking sees the real modules.
      '@kvitto/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  worker: {
    // Module workers, so dev and production load the CV worker the same way:
    // Vite always serves workers as ES modules in dev, and a classic worker
    // would therefore only ever work in a production build.
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: true,
    // getUserMedia needs a secure context. `localhost` counts; testing on a
    // phone over the LAN does not, so run `vite --https` or use a tunnel.
    port: 5173,
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['apple-touch-icon.png', 'favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'KvittoApp — kvittoskanner',
        short_name: 'Kvitto',
        description:
          'Skanna, tolka och sök i dina kvitton. Fungerar helt offline och synkar när du är uppkopplad.',
        lang: 'sv-SE',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f172a',
        theme_color: '#102a4a',
        categories: ['finance', 'productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Skanna kvitto', short_name: 'Skanna', url: '/#/scan' },
          { name: 'Alla köp', short_name: 'Köp', url: '/#/purchases' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // OpenCV is fetched on demand and runtime-cached instead (see below),
        // so a fresh install does not pull 11 MB before the first scan.
        globIgnores: ['**/vendor/opencv.js'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname === '/vendor/opencv.js',
            handler: 'CacheFirst',
            options: {
              cacheName: 'kvitto-opencv',
              // The file is version-pinned in package.json, so a hit is always valid.
              expiration: { maxEntries: 2, maxAgeSeconds: ONE_YEAR },
              cacheableResponse: { statuses: [0, 200] },
              matchOptions: { ignoreVary: true },
            },
          },
        ],
      },
      devOptions: {
        // Lets the offline behaviour be exercised with `vite dev`.
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },
    }),
  ],
});
