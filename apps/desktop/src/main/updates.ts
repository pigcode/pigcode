/**
 * 检查更新在 main 里的入口（pigcode/pigcode#67）：把节拍交给 update-scheduler，
 * 这里只负责「有新版本时弹一句、点了打开下载页」。下载页是 GitHub Release（ADR 0010）。
 */
import { app, dialog, shell, type BrowserWindow } from "electron"
import { LATEST_RELEASE_API, type LatestRelease } from "./update-check"
import { createUpdateScheduler } from "./update-scheduler"
import { updateLabels } from "./locale/update"

export interface Updates {
  /** 按当前偏好起停自动检查；偏好改了再调一次。 */
  start(): void
  /** 设置页的手动检查。 */
  checkNow(): Promise<{
    status: "up-to-date" | "update-available" | "error"
    version?: string
    url?: string
  }>
}

export function createUpdates(options: {
  getWindow: () => BrowserWindow | undefined
  autoCheck: () => boolean
}): Updates {
  /** 有新版本时问一句，点「下载」打开 Release 页面。 */
  const prompt = async (release: LatestRelease): Promise<void> => {
    const labels = updateLabels(app.getLocale())
    const message = {
      type: "info" as const,
      buttons: [labels.download, labels.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: labels.title.replace("{version}", release.version),
      detail: labels.detail,
    }
    const window = options.getWindow()
    // 窗口隐藏到托盘时，macOS 上的 sheet 不会显示：提示先把它叫出来。
    if (window && !window.isDestroyed() && !window.isVisible()) window.show()
    const { response } =
      window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, message)
        : await dialog.showMessageBox(message)
    if (response === 0) await shell.openExternal(release.url)
  }
  const scheduler = createUpdateScheduler({
    apiUrl: () => process.env.PIGCODE_UPDATE_API ?? LATEST_RELEASE_API,
    // E2E 用 PIGCODE_UPDATE_CHECK=0 整个关掉。
    enabled: () => process.env.PIGCODE_UPDATE_CHECK !== "0",
    autoCheck: options.autoCheck,
    currentVersion: () => app.getVersion(),
    prompt,
    log: (message) => console.warn(message),
  })
  return { start: () => scheduler.start(), checkNow: () => scheduler.checkNow() }
}
