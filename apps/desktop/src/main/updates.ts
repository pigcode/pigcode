/**
 * 检查更新在 main 里的入口（pigcode/pigcode#67、#71）：把节拍交给 update-scheduler，
 * 这里负责「发现新版本之后做什么」。下载页和更新源都是 GitHub Release（ADR 0010）。
 */
import { app, dialog, shell, type BrowserWindow } from "electron"
import { LATEST_RELEASE_API, fetchLatestRelease, type LatestRelease } from "./update-check"
import { canInstallUpdates, updateMode, type UpdateMode } from "./update-mode"
import { createUpdateScheduler } from "./update-scheduler"
import { updateLabels } from "./locale/update"

/** 设置页手动检查的结果。 */
export interface UpdateResult {
  status: "up-to-date" | "update-available" | "error"
  version?: string
  url?: string
}

export interface Updates {
  /** 按当前偏好起停自动检查；偏好改了再调一次。 */
  start(): void
  /** 设置页的手动检查。 */
  checkNow(): Promise<UpdateResult>
}

export interface UpdateOptions {
  getWindow: () => BrowserWindow | undefined
  autoCheck: () => boolean
  /** Windows 和 AppImage 自动下载并安装；macOS 和 deb 只提示。 */
  mode?: UpdateMode
  /** 开发运行时 electron-updater 读不到 app-update.yml，只提示。 */
  isPackaged?: boolean
  /** 「重启并更新」走正常退出流程，任务确认在退出前完成。 */
  requestRestart?: () => void
  /** 测试用：替换下载实现。 */
  download?: () => Promise<boolean>
  /** 测试用：替换查询最新版本。 */
  fetchRelease?: typeof fetchLatestRelease
}

/** 等一句确认：buttons 是 [确定, 取消]，返回是否选了第一个。 */
async function ask(options: {
  getWindow: () => BrowserWindow | undefined
  message: Electron.MessageBoxOptions
}): Promise<boolean> {
  const window = options.getWindow()
  // 窗口隐藏到托盘时，macOS 上的 sheet 不会显示：提示先把它叫出来。
  if (window && !window.isDestroyed() && !window.isVisible()) window.show()
  const { response } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options.message)
      : await dialog.showMessageBox(options.message)
  return response === 0
}

export function createUpdates(options: UpdateOptions): Updates {
  const mode = options.mode ?? updateMode(process.platform, process.env)
  const install = canInstallUpdates(mode, options.isPackaged ?? app.isPackaged)
  const download = options.download ?? downloadWithUpdater

  /** 只提示：打开下载页。 */
  const showDownloadPage = async (release: LatestRelease): Promise<void> => {
    const labels = updateLabels(app.getLocale())
    const open = await ask({
      getWindow: options.getWindow,
      message: {
        type: "info",
        buttons: [labels.download, labels.later],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: labels.title.replace("{version}", release.version),
        detail: labels.detail,
      },
    })
    if (open) await shell.openExternal(release.url)
  }

  /** 已经下载好：现在重启安装，或者等到下次退出（electron-updater 会自动装）。 */
  const showReady = async (version: string): Promise<void> => {
    const labels = updateLabels(app.getLocale())
    const restart = await ask({
      getWindow: options.getWindow,
      message: {
        type: "info",
        buttons: [labels.restart, labels.later],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: labels.readyTitle.replace("{version}", version),
        detail: labels.readyDetail,
      },
    })
    if (restart) (options.requestRestart ?? (() => app.quit()))()
  }

  const prompt = async (release: LatestRelease): Promise<void> => {
    if (install) {
      // 后台下载好，下次退出时安装；下载失败就退回下载页，别让用户没有出路。
      if (await download()) {
        await showReady(release.version)
        return
      }
      console.warn("update download failed")
    }
    await showDownloadPage(release)
  }

  const scheduler = createUpdateScheduler({
    apiUrl: () => process.env.PIGCODE_UPDATE_API ?? LATEST_RELEASE_API,
    // E2E 用 PIGCODE_UPDATE_CHECK=0 整个关掉。
    enabled: () => process.env.PIGCODE_UPDATE_CHECK !== "0",
    autoCheck: options.autoCheck,
    currentVersion: () => app.getVersion(),
    prompt,
    log: (message) => console.warn(message),
    ...(options.fetchRelease ? { fetchRelease: options.fetchRelease } : {}),
  })
  return { start: () => scheduler.start(), checkNow: () => scheduler.checkNow() }
}

/** 下载更新。electron-updater 按 electron-builder 写进安装包的 app-update.yml 找源。 */
async function downloadWithUpdater(): Promise<boolean> {
  try {
    const { autoUpdater } = await import("electron-updater")
    autoUpdater.autoDownload = false
    // 下载完成后用户没点「重启并更新」也在退出时装上。
    autoUpdater.autoInstallOnAppQuit = true
    const result = await autoUpdater.checkForUpdates()
    if (!result) return false
    await autoUpdater.downloadUpdate()
    return true
  } catch (error) {
    console.warn("update download failed", error instanceof Error ? error.message : error)
    return false
  }
}
