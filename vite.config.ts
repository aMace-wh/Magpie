/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

const THEME = '#15131f';

export default defineConfig({
  // Relative base + hash routing lets the build be hosted from any sub-path (e.g. GitHub Pages).
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      // Our own service worker (src/sw.ts) so it can receive POSTed shares; Workbox injects the precache list.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: './',
        name: 'Magpie — Save it. Sort it. Do it.',
        short_name: 'Magpie',
        description:
          'Save links, videos, recipes, places and ideas from anywhere. Magpie sorts them into collections, pins places on a map and keeps a journal of what you actually did.',
        start_url: './',
        scope: './',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'portrait',
        background_color: THEME,
        theme_color: THEME,
        categories: ['productivity', 'lifestyle', 'utilities'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Lets the installed app appear in the Android / ChromeOS / Windows share sheet — for links, text and
        // Magpie share files. The service worker (src/sw.ts) handles the POST.
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [{ name: 'file', accept: ['application/json', '.json', '.magpie', 'text/plain'] }],
          },
        },
        // Opening a .magpie / .json share file with the installed app (desktop Chromium).
        file_handlers: [{ action: './', accept: { 'application/json': ['.magpie', '.json'] } }],
        shortcuts: [
          { name: 'Save something', short_name: 'Save', url: './#/new', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
          { name: 'Map', url: './#/map', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
          { name: 'Journal', url: './#/journal', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
