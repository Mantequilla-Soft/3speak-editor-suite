import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import ffmpegCore from './scripts/viteFfmpegCore.js'

export default defineConfig({
  plugins: [react(), ffmpegCore()],
  server: {
    port: 8089,
    host: '0.0.0.0',
    allowedHosts: ['3speak-editor.okinoko.io'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    }
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  build: {
    rollupOptions: {
      output: {
        // One chunk per interface language (src/i18n loads them on demand), not one per area file
        manualChunks(id) {
          const m = id.match(/[\\/]src[\\/]locales[\\/]([a-z]{2,3})[\\/]/)
          if (m && m[1] !== 'en') return `locale-${m[1]}`
        }
      }
    }
  }
})
