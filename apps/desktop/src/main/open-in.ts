/** 用本机的文件管理器、编辑器或终端打开项目文件夹；只接受已存在的绝对目录。 */
import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { DetectedApp, OpenAppKind } from "./open-apps"

/** 交给页面的应用信息；icon 是 data URL，取不到时为 null。 */
export interface OpenAppInfo {
  id: string
  name: string
  kind: OpenAppKind
  icon: string | null
}

/** 已存在的绝对目录原样返回，其余一律为 null。 */
export function readDirectory(
  value: unknown,
  isDirectory: (path: string) => boolean = (path) => statSync(path).isDirectory(),
): string | null {
  if (typeof value !== "string" || !isAbsolute(value)) return null
  try {
    return isDirectory(value) ? value : null
  } catch {
    return null
  }
}

/** 已存在的文件或文件夹的绝对路径；其他值返回 null。 */
export function readExistingPath(
  value: unknown,
  exists: (path: string) => boolean = (path) => existsSync(path),
): string | null {
  if (typeof value !== "string" || !isAbsolute(value)) return null
  try {
    return exists(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 等 shell.openPath 的结果，最多等 waitMs。Linux 会话总线不可用时，文件管理器照样打开，
 * openPath 却可能一直不返回；超时就当作已经交给了系统，免得页面一直等不到回复。
 */
export function settleOpenPath(result: Promise<string>, waitMs = 1500): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), waitMs)
  })
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 用指定应用打开文件夹的命令。文件管理器返回 null，交给 shell.openPath；
 * macOS 统一用 `open -a`，不依赖 PATH 上的 CLI（从 Dock 启动的应用拿不到 shell 的 PATH）。
 */
export function launchCommand(
  app: DetectedApp,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
  if (app.def.kind === "file-manager") return null
  if (platform === "darwin") return { command: "open", args: ["-a", app.location, folder] }
  return { command: app.location, args: app.def.args?.(folder) ?? [folder] }
}

/** 脱离 Pigcode 启动应用：不等它退出，也不接它的输出；启动失败时抛错。 */
export function launchDetached(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}
