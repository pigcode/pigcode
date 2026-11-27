#!/usr/bin/env node
import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const candidates = [
  new URL("../host/headless.mjs", import.meta.url),
  new URL("../../desktop/out/host/headless.mjs", import.meta.url),
]

const bundleUrl = candidates.find((url) => existsSync(fileURLToPath(url)))

if (!bundleUrl) {
  process.stderr.write("Pigcode Host 尚未构建，请先运行 pnpm build:host\n")
  process.exit(1)
}

const mod = await import(pathToFileURL(fileURLToPath(bundleUrl)).href)
if (typeof mod.main === "function") {
  process.exitCode = await mod.main(process.argv.slice(2))
}
