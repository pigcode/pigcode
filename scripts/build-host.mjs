/** 把 Host utilityProcess 入口打成可加载的单文件。 */
import { createRequire } from "node:module"

// esbuild 声明在 apps/desktop 下，脚本仍从仓库根目录执行。
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url))
const { build } = require("esbuild")

await build({
  entryPoints: ["apps/host/src/entry.ts"],
  outfile: "apps/desktop/out/host/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  sourcemap: true,
})
