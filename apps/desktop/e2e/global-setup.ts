/**
 * E2E 启动前构建 Electron 产物与 Host utilityProcess bundle，并清空上一次的用户 profile。
 *
 * `test:packaged` 之前一定刚跑过 `package:*`，那里已经构建过同样的产物，且比源码新。
 * 这时跳过重建，省掉 CI 上重复的一遍；尺寸判断放在这里而不是脚本里，是为了在三个平台的
 * shell 里行为一致（Windows 的 cmd 没有 `VAR=x cmd` 前缀写法）。
 */
import { execFileSync } from "node:child_process"
import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildExamples } from "../../../scripts/build-examples"

/** 一次构建的产物；它比这些输入新就不用重建。 */
const OUTPUTS = ["out/main/index.js", "out/host/index.mjs"]

/** 这些目录下的任何文件比产物新，就要重建。 */
const SOURCES = ["src", "../host/src", "../../packages"]

/** 文件的修改时间；不存在时返回 0。 */
function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 从 root 起递归找最新的修改时间；跳过 node_modules 与构建输出。 */
function newestUnder(root: string): number {
  let newest = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "out" || entry.name === "dist") continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) newest = Math.max(newest, mtime(path))
    }
  }
  return newest
}

/** 产物是否比所有源码都新。 */
function outputsAreFresh(desktopDir: string): boolean {
  const built = Math.min(...OUTPUTS.map((path) => mtime(join(desktopDir, path))))
  if (built === 0) return false
  const newestSource = Math.max(...SOURCES.map((dir) => newestUnder(join(desktopDir, dir))))
  return built > newestSource
}

/** 依次执行 electron-vite 构建、Host esbuild 打包和样例插件打包。 */
export default function globalSetup(): void {
  const desktopDir = fileURLToPath(new URL("..", import.meta.url))
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
  const shell = process.platform === "win32"
  // 打包流程刚建过 out/ 和 out/host；样例插件仍然要建，因为它不参与打包。
  if (!outputsAreFresh(desktopDir)) {
    execFileSync("pnpm", ["exec", "electron-vite", "build"], {
      cwd: desktopDir,
      stdio: "inherit",
      shell,
    })
    execFileSync(process.execPath, ["scripts/build-host.ts"], {
      cwd: repoRoot,
      stdio: "inherit",
    })
  }
  // 样例插件是构建后安装的（adr/0006），用例装的是它们的 dist。
  buildExamples(repoRoot)
  const profileDir = process.env.PIGCODE_PROFILE_DIR
  if (profileDir) rmSync(profileDir, { recursive: true, force: true })
}
