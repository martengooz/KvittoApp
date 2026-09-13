import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// @ts-expect-error -- plain ESM helper shared with the icon generator.
import { launchScreenLinks } from './scripts/launch-screens.mjs';

/** One year, in seconds — used for the immutable vendor bundle. */
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Where the app is served from.
 *
 * GitHub Pages serves a project site under `/<repo>/`, not the domain root, so
 * every absolute URL the app emits has to carry that prefix. It is an
 * environment variable rather than a constant so the same build works for
 * Pages, a custom domain (`/`) and any other sub-path.
 */
const base = process.env.KVITTO_BASE ?? '/';

/** Joins `base` with a root-relative path, avoiding a doubled slash. */
function withBase(path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/**
 * Injects the iOS `apple-touch-startup-image` tags.
 *
 * Generated rather than written by hand: there are 30 of them, each needing an
 * exact media query, and they have to carry the deployment's base path. The
 * geometry comes from the same table the image generator uses.
 */
function launchScreens(): Plugin {
  return {
    name: 'kvitto-launch-screens',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        return html.replace('<!--launch-screens-->', launchScreenLinks(base) as string);
      },
    },
  };
}

export default defineConfig({
  base,
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
    launchScreens(),
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
        // Relative, so the manifest is correct under any base path.
        id: base,
        start_url: '.',
        scope: base,
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
          { name: 'Skanna kvitto', short_name: 'Skanna', url: `${withBase('')}#/scan` },
          { name: 'Alla köp', short_name: 'Köp', url: `${withBase('')}#/purchases` },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // OpenCV is fetched on demand and runtime-cached instead (see below),
        // so a fresh install does not pull 11 MB before the first scan.
        globIgnores: ['**/vendor/opencv.js', '**/launch/*.png'],
        navigateFallback: withBase('index.html'),
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // A RegExp, not a function: Workbox serialises `urlPattern` into
            // the generated service worker, and a function would carry a
            // reference to `withBase`, which does not exist in that scope. The
            // suffix match is base-agnostic, so it keeps working under any
            // deployment path.
            urlPattern: /\/vendor\/opencv\.js(?:\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'kvitto-opencv',
              // The file is version-pinned in package.json, so a hit is always valid.
              expiration: { maxEntries: 2, maxAgeSeconds: ONE_YEAR },
              cacheableResponse: { statuses: [0, 200] },
              matchOptions: { ignoreVary: true },
            },
          },
          {
            // ~450 kB of launch screens that only Safari ever requests, and
            // only one of which any given device needs. Precaching them all
            // would be most of the install budget spent on a splash image.
            urlPattern: /\/launch\/[\d]+x[\d]+\.png$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'kvitto-launch',
              expiration: { maxEntries: 4, maxAgeSeconds: ONE_YEAR },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Lets the offline behaviour be exercised with `vite dev`.
        enabled: true,
        type: 'module',
        navigateFallback: withBase('index.html'),
      },
    }),
  ],
});
