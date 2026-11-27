/** Pigcode 无窗口常驻 Host 与 CLI 统一入口（供 `bin/pigcode-host.mjs` 与直接导入运行）。 */
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runHeadlessCli, type HeadlessCliDeps } from "./kernel/headless-cli"

export { runHeadlessCli, type HeadlessCliDeps }

/** 运行 headless CLI 主流程并返回退出码。 */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps?: HeadlessCliDeps,
): Promise<number> {
  return runHeadlessCli(argv, deps)
}

function normalizePathForCompare(target: string): string {
  try {
    const real = realpathSync(target)
    return process.platform === "win32" ? real.toLowerCase() : real
  } catch {
    const resolved = resolve(target)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
}

function isDirectEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return normalizePathForCompare(entry) === normalizePathForCompare(fileURLToPath(import.meta.url))
}

if (isDirectEntry()) {
  void main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
