import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Light-theme brand colour; `index.html` sets per-scheme `theme-color` metas. */
const THEME_COLOR = '#2563eb';
const BACKGROUND_COLOR = '#ffffff';

// The relay serves `dist/` from the same origin as `/api` and `/ws` (D1, 06 §5.1):
// hashed `assets/*` are immutable, everything else is `no-cache`.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // The SW calls skipWaiting/clientsClaim itself; registration is a deferred script.
      injectRegister: 'script-defer',
      injectManifest: {
        // The plugin adds `manifest.webmanifest` to the precache list itself.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
      },
      manifest: {
        id: '/',
        name: 'remote-control',
        short_name: 'remote-control',
        description: 'Approve, answer and start AI coding agent sessions from your phone.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: THEME_COLOR,
        background_color: BACKGROUND_COLOR,
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // `globPatterns` already precaches every icon; listing them again duplicates entries.
      includeManifestIcons: false,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // D3 platform floor: iOS 17+, Chrome Android 133+.
    target: ['safari17', 'chrome133'],
  },
});
