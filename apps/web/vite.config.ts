import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: { port: 4173, strictPort: true,
    proxy: { '/v1': { target: process.env.SCOPEHATCH_API_UPSTREAM || 'http://127.0.0.1:3000', changeOrigin: true },
      '/healthz': { target: process.env.SCOPEHATCH_API_UPSTREAM || 'http://127.0.0.1:3000', changeOrigin: true } }
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
