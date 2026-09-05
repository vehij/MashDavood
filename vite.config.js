import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  publicDir: resolve(__dirname, 'assets'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/index.html')
      }
    }
  },
  server: { port: 5273, strictPort: true }
})
