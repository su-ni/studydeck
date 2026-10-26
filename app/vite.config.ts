import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// 构建产物直接落进 web/app-dist，由 FastAPI 静态挂载，跟现有原生页面并存。
// 开发期走 5173 + /api 代理到 8770，不依赖后端已起。
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8770', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8770', changeOrigin: true },
      '/img': { target: 'http://127.0.0.1:8770', changeOrigin: true },
      '/shots': { target: 'http://127.0.0.1:8770', changeOrigin: true },
    },
  },
  build: {
    outDir: '../web/app-dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})
