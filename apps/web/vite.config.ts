import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: { port: 4173, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
