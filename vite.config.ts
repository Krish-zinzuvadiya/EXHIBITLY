import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Exhibity',
        short_name: 'Exhibity',
        description: 'A mobile-first workspace for expo leads',
        theme_color: '#f7f5f1',
        background_color: '#f7f5f1',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/expo-mark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: { navigateFallback: '/', globPatterns: ['**/*.{js,css,html,svg,png,webp,woff,woff2}'] },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:4000' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor'
          if (id.includes('/recharts/') || id.includes('/d3-')) return 'charts'
          if (id.includes('/@tanstack/') || id.includes('/react-router')) return 'routing-vendor'
          return undefined
        },
      },
    },
  },
})
