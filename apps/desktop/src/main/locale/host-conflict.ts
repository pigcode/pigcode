/**
 * `host.lock` 冲突提示框文案：当目标数据目录已被无窗口后台服务或另一个桌面实例占用时，
 * 主进程按系统语言（`app.getLocale()`）选择中文或英文弹窗说明。
 */
import type { HostLockMetadata } from "@pigcode/contracts"

export interface HostConflictDialogText {
  type: "error"
  message: string
  detail: string
}

/** 生成 `host.lock` 冲突提示框的文案（按 locale 选择中文或英文），区分无窗口后台服务与另一桌面实例。 */
export function hostConflictDialogText(
  owner: HostLockMetadata,
  dir: string,
  locale = "zh-CN",
): HostConflictDialogText {
  if (locale.toLowerCase().startsWith("zh")) {
    const detail =
      owner.runtime === "headless"
        ? `无窗口后台服务（headless，PID ${owner.pid}）正在使用数据目录：\n${dir}\n\n请先停止该后台服务，或改用其他数据目录后再启动桌面端。`
        : `另一个桌面实例（PID ${owner.pid}）正在使用数据目录：\n${dir}\n\n请先关闭该实例后再重试。`
    return {
      type: "error",
      message: "Pigcode 无法启动：数据目录已被占用",
      detail,
    }
  }
  const detail =
    owner.runtime === "headless"
      ? `A headless background service (PID ${owner.pid}) is using the profile directory:\n${dir}\n\nStop that service or use another profile directory before launching Pigcode.`
      : `Another desktop instance (PID ${owner.pid}) is using the profile directory:\n${dir}\n\nClose that instance and try again.`
  return {
    type: "error",
    message: "Pigcode cannot start: profile directory is in use",
    detail,
  }
}
