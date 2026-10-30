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
    rollupOptions: {
      output: {
        /* 分包：把「几乎不会变」和「只在某一页用」的东西从入口里摘出去。
           原来是一个 700KB 的 index.js 全量首屏加载 —— 打开课程主页那一刻，
           画布页的 reactflow（含 d3 一套）也跟着下载，用户可能一整天都不点画布。

           这里只按包名切，按页面切（Canvas/Agent/…）交给 App.tsx 的 React.lazy：
           路由级懒加载必须在 import 那一侧表达，manualChunks 只负责把公共大件
           提成独立 chunk，两边不重复。

           匹配用「最后一个 node_modules 之后的路径」：包里嵌套 node_modules
           时（a/node_modules/b），用第一段匹配会认错包名。
           命不中的（classcat、zustand 等）不在这里列 —— 它们只被 reactflow 用，
           rollup 自己会把它们归进 flow 那个 chunk。硬写死反而会把一个可能被
           别处共享的包钉在 flow 上，导致首屏被迫先下 flow 才能跑。 */
        manualChunks(id: string) {
          const p = id.replace(/\\/g, '/')
          if (!p.includes('/node_modules/')) return
          const pkgPath = p.split('/node_modules/').pop() || ''
          // react / react-dom / scheduler：每个页面都用，且版本一变全站缓存失效，
          // 单独一个 chunk 让它长期待在浏览器缓存里。
          if (/^(react|react-dom|scheduler)\//.test(pkgPath)) return 'react'
          // reactflow + 它带的 d3-*：只有画布页 import，进去才下。
          if (/^(reactflow|@reactflow|d3-[a-z-]+)\//.test(pkgPath)) return 'flow'
        },
      },
    },
  },
})
