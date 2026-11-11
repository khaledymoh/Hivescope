import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // ECharts is one large bundle; that's fine for a page served from this PC.
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: {
    host: '127.0.0.1',
    port: 5317,
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
})
