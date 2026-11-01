/** Electron 构建配置：renderer 使用 React，样式是 ui-primitives 里的普通 CSS。 */
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"

export default defineConfig({
  // 标题栏默认色取自 ui-primitives 的 tokens.css 与纯函数模块；它的入口是 TS 源码，打进 main 而不外置。
  main: {
    build: { outDir: "out/main", externalizeDeps: { exclude: ["@pigcode/ui-primitives"] } },
  },
  // sandbox 渲染器只能加载 CJS preload，因此显式输出 .cjs。
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    // electron-vite 默认不压缩；渲染进程的脚本压缩后体积约减半，冷启动解析更快。
    build: { outDir: "out/renderer", minify: "esbuild" },
  },
})
