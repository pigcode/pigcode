/** E2E 启动前构建 Electron 产物与 Host utilityProcess bundle。 */
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/** 依次执行 electron-vite 构建和 Host esbuild 打包。 */
export default function globalSetup(): void {
  const desktopDir = fileURLToPath(new URL("..", import.meta.url))
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
  const shell = process.platform === "win32"
  execFileSync("pnpm", ["exec", "electron-vite", "build"], {
    cwd: desktopDir,
    stdio: "inherit",
    shell,
  })
  execFileSync(process.execPath, ["scripts/build-host.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
  })
}
