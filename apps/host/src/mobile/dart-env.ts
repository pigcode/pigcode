import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

let cached: boolean | undefined

/** 检查本机是否安装了 Dart SDK 且已为 pigcode_client 生成 package_config.json。 */
export function hasDartClientEnv(): boolean {
  if (cached !== undefined) return cached
  const mobileRoot = fileURLToPath(new URL("../../../mobile", import.meta.url))
  const clientPkgDir = join(mobileRoot, "packages", "pigcode_client")
  const hasPackageConfig =
    existsSync(join(mobileRoot, ".dart_tool", "package_config.json")) ||
    existsSync(join(clientPkgDir, ".dart_tool", "package_config.json"))
  if (!hasPackageConfig) {
    cached = false
    return false
  }
  const probe = spawnSync("dart", ["--version"], { stdio: "ignore" })
  cached = !probe.error && probe.status === 0
  return cached
}
