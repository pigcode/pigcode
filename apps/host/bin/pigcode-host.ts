#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const realPath = realpathSync(fileURLToPath(import.meta.url))
const selfUrl = pathToFileURL(realPath)
const candidates = [
  new URL("../host/headless.mjs", selfUrl),
  new URL("../out/headless/host/headless.mjs", selfUrl),
  new URL("../../desktop/out/host/headless.mjs", selfUrl),
]

const bundleUrl = candidates.find((url) => existsSync(fileURLToPath(url)))

if (!bundleUrl) {
  process.stderr.write("Pigcode Host 尚未构建，请先运行 pnpm build:headless\n")
  process.exit(1)
}

// 先把 process.argv[1] 规范化为脚本真实路径，再加载 headless.mjs，
// 避免通过全局 npm link 软链接调用时依赖向上的路径解析找不到 node_modules。
process.argv[1] = realPath

const mod = (await import(bundleUrl.href)) as {
  main?: (argv: string[]) => Promise<number>
}
if (typeof mod.main !== "function") {
  process.stderr.write("Pigcode Host 入口损坏：缺少 main 导出，请重新运行 pnpm build:headless\n")
  process.exit(1)
}

process.exitCode = await mod.main(process.argv.slice(2))
