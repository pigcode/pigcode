/** Electron 构建配置：main/preload/renderer 分开输出。 */
import { defineConfig } from "electron-vite"

export default defineConfig({
  main: { build: { outDir: "out/main" } },
  // sandbox 渲染器只能加载 CJS preload，因此显式输出 .cjs。
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: { root: "src/renderer", build: { outDir: "out/renderer" } },
})
