/** E2E 启动前构建 Electron 产物与 Host utilityProcess bundle，并清空上一次的用户 profile。 */
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildExamples } from "../../../scripts/build-examples"

/** 依次执行 electron-vite 构建、Host esbuild 打包和样例插件打包。 */
export default function globalSetup(): void {
  const desktopDir = fileURLToPath(new URL("..", import.meta.url))
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
  const shell = process.platform === "win32"
  execFileSync("pnpm", ["exec", "electron-vite", "build"], {
    cwd: desktopDir,
    stdio: "inherit",
    shell,
  })
  execFileSync(process.execPath, ["scripts/build-host.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
  })
  // 样例插件是构建后安装的（adr/0006），用例装的是它们的 dist。
  buildExamples(repoRoot)
  const profileDir = process.env.PIGCODE_PROFILE_DIR
  if (profileDir) rmSync(profileDir, { recursive: true, force: true })
}
