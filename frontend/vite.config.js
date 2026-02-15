import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5174,
    proxy: {
      '/api/fusion': {
        target: 'http://127.0.0.1:5051',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fusion/, '/api'),
      },
      '/api/stream': {
        target: 'http://127.0.0.1:5056',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/stream/, '/stream'),
      },
    },
  },
})
