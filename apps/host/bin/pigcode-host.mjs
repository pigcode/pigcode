#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)))
const candidates = [
  new URL("../host/headless.mjs", selfUrl),
  new URL("../../desktop/out/host/headless.mjs", selfUrl),
]

const bundleUrl = candidates.find((url) => existsSync(fileURLToPath(url)))

if (!bundleUrl) {
  process.stderr.write("Pigcode Host 尚未构建，请先运行 pnpm build:host\n")
  process.exit(1)
}

const mod = await import(pathToFileURL(fileURLToPath(bundleUrl)).href)
if (typeof mod.main !== "function") {
  process.stderr.write("Pigcode Host 入口损坏：缺少 main 导出，请重新运行 pnpm build:host\n")
  process.exit(1)
}

process.exitCode = await mod.main(process.argv.slice(2))
