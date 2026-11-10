/** Electron 构建配置：renderer 使用 React，样式是 ui-primitives 里的普通 CSS。 */
import { readFileSync } from "node:fs"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import type { Plugin } from "vite"

/** 产品版本：唯一来源是 package.json，编译时替换掉代码里的 __PIGCODE_VERSION__（adr/0007）。 */
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  .version as string
const define = { __PIGCODE_VERSION__: JSON.stringify(appVersion) }

/**
 * 插件共享模块（ADR-0002）的入口。产物名固定为 `shared/<名字>.js`，和 index.html 的 import map 对应。
 *
 * 这些入口只用来让 Vite 把模块打进 `shared/`，不能在页面里再加载一遍：页面已经通过 import map
 * 按裸包名 import 它们（宿主自己的组件也这么写），额外的 `<script type="module">` 只是多一次导入。
 */
const sharedModules: Record<string, string> = {
  "shared/react": "src/renderer/src/shared/react.ts",
  "shared/react-dom": "src/renderer/src/shared/react-dom.ts",
  "shared/react-dom-client": "src/renderer/src/shared/react-dom-client.ts",
  "shared/jsx-runtime": "src/renderer/src/shared/jsx-runtime.ts",
  "shared/jsx-dev-runtime": "src/renderer/src/shared/jsx-dev-runtime.ts",
  "shared/ui-primitives": "src/renderer/src/shared/ui-primitives.ts",
  "shared/plugin-sdk": "src/renderer/src/shared/plugin-sdk.ts",
}

/**
 * 让 Vite 输出共享模块文件，但不把它们作为脚本插进 index.html。
 *
 * 页面只通过 import map 按包名取这些模块（宿主自己的组件也这么 import）；如果 Vite 再把每个入口作为
 * `<script type="module">` 插进页面，只是多一次已经缓存过的导入，没有意义。
 * 只在构建时生效；开发模式下 main 加载 dev server，共享模块见 sharedModulesFromSource。
 */
function sharedModuleEntries(): Plugin {
  return {
    name: "pigcode:shared-module-entries",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html: string) {
        return html.replace(/[ \t]*<script[^>]+shared\/[^"]+\.js"[^>]*><\/script>\n?/g, "")
      },
    },
  }
}

/**
 * 开发模式下的共享模块：dev server 没有 `shared/*.js`，import map 改成指向入口源码 `/src/shared/*.ts`。
 *
 * 宿主自己的代码 import "react" 时，Vite 把它改写成预构建依赖的 URL；入口源码里的 import 被改写成同一个
 * URL，插件经 import map 拿到的仍然是宿主正在用的那份 React 与 `@pigcode/ui-primitives`（ADR-0002）。
 */
function sharedModulesFromSource(): Plugin {
  return {
    name: "pigcode:shared-modules-from-source",
    apply: "serve",
    transformIndexHtml(html: string) {
      return html.replace(/"\.\/(shared\/[^"]+)\.js"/g, (match, name: string) => {
        const source = sharedModules[name]
        return source ? JSON.stringify(`/${source.replace(/^src\/renderer\//, "")}`) : match
      })
    },
  }
}

export default defineConfig({
  // 标题栏默认色取自 ui-primitives 的 tokens.css 与纯函数模块；它的入口是 TS 源码，打进 main 而不外置。
  main: {
    define,
    build: { outDir: "out/main", externalizeDeps: { exclude: ["@pigcode/ui-primitives"] } },
  },
  // sandbox 渲染器只能加载 CJS preload，因此显式输出 .cjs。
  preload: {
    define,
    build: {
      outDir: "out/preload",
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    define,
    root: "src/renderer",
    plugins: [react(), sharedModuleEntries(), sharedModulesFromSource()],
    // electron-vite 默认不压缩；渲染进程的脚本压缩后体积约减半，冷启动解析更快。
    build: {
      outDir: "out/renderer",
      minify: "esbuild",
      rollupOptions: {
        // 共享模块是独立入口：入口签名不能丢，否则 `export *` 会退化成只转发内部对象。
        preserveEntrySignatures: "strict",
        input: { index: "src/renderer/index.html", ...sharedModules },
        output: {
          // 共享模块的路径写在 import map 里，必须是固定名字；其余照旧按内容哈希。
          entryFileNames: (chunk) =>
            chunk.name.startsWith("shared/") ? `${chunk.name}.js` : "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  },
})
