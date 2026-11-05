/**
 * 构建插件包：把 `pigcode.host` / `pigcode.client` 指向的 TypeScript 入口打包成 `dist/*.js`。
 * 宿主的共享模块（React、JSX runtime、ui-primitives、插件 SDK）保留裸 import，运行时由宿主提供（ADR-0002）。
 * 打包后的插件不再需要安装时编译，应用也就不必带编译器（ADR-0006）。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { build } from "esbuild"

/** 由宿主在运行时提供的模块；不能打进插件自己的文件。 */
const SHARED = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@pigcode/ui-primitives",
  "@pigcode/plugin-sdk",
]

interface Manifest {
  pigcode?: { host?: unknown; client?: unknown }
}

const dir = process.cwd()
const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest
// 源文件按约定命名；manifest 里声明了对应入口才构建，产物写到它指向的 dist。
const candidates = [
  { entry: "host", source: "index.ts", outfile: "dist/index.js", platform: "node" },
  { entry: "client", source: "client.tsx", outfile: "dist/client.js", platform: "browser" },
] as const

let built = 0
for (const candidate of candidates) {
  const declared = manifest.pigcode?.[candidate.entry as "host" | "client"]
  if (typeof declared !== "string") continue
  const entryPoint = join(dir, candidate.source)
  if (!existsSync(entryPoint)) continue
  await build({
    entryPoints: [entryPoint],
    outfile: join(dir, candidate.outfile),
    bundle: true,
    format: "esm",
    platform: candidate.platform,
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "react",
    external: SHARED,
    logLevel: "warning",
  })
  built += 1
  console.log(`${dir}: ${candidate.source} → ${candidate.outfile}`)
}
if (built === 0) console.log(`${dir}: nothing to build`)
