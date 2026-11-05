/**
 * node-pty 1.1.0 发布的 npm 包里，macOS 预编译的 spawn-helper 没有执行权限，安装脚本也不补，
 * 打开终端时会报 posix_spawnp failed。用 electron-rebuild 重新编译过的副本不受影响，所以只有全新安装才会碰到。
 */
import { chmodSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

if (process.platform === "darwin") {
  const host = createRequire(new URL("../apps/host/package.json", import.meta.url))
  const nodePty = dirname(host.resolve("node-pty/package.json"))
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const helper = join(nodePty, "prebuilds", arch, "spawn-helper")
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
