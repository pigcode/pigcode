/**
 * 检查更新在 main 里的入口（pigcode/monorepo#67、#71）：把节拍交给 update-scheduler，
 * 这里负责「发现新版本之后做什么」。下载页和更新源都是 GitHub Release（ADR 0010）。
 */
import { app, dialog, shell, type BrowserWindow } from "electron"
import { RELEASES_API, fetchLatestRelease, type LatestRelease } from "./update-check"
import { downloadPackage, pickDmg, type DownloadedPackage } from "./update-download"
import { canInstallUpdates, canReplaceApp, updateMode, type UpdateMode } from "./update-mode"
import { createUpdateScheduler } from "./update-scheduler"
import { settleOpenPath } from "./open-in"
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
  /** 已经下载好时退出并安装，返回是否接过了这次退出。 */
  installIfReady(): boolean
}

export interface UpdateOptions {
  getWindow: () => BrowserWindow | undefined
  autoCheck: () => boolean
  /** 用户偏好：接不接预发布版本。缺省按不接处理，测试里不用每次都写。 */
  allowPrerelease?: () => boolean
  /** Windows 和 AppImage 自动下载并安装；macOS 和 deb 只提示。 */
  mode?: UpdateMode
  /** 开发运行时 electron-updater 读不到 app-update.yml，只提示。 */
  isPackaged?: boolean
  /** 「重启并更新」走正常退出流程，任务确认在退出前完成。 */
  requestRestart?: () => void
  /** 测试用：替换下载实现。 */
  download?: () => Promise<boolean>
  /** 测试用：替换「装好并重启」。 */
  install?: () => void
  /** 测试用：替换查询最新版本。 */
  fetchRelease?: typeof fetchLatestRelease
  /** 测试用：替换「下载完整包」。 */
  downloadPackage?: (release: LatestRelease) => Promise<DownloadedPackage>
  /** 测试用：替换架构与打开安装包，避免真的弹出 Finder。 */
  arch?: string
  /** 打开安装包；返回错误描述，空串表示成功（和 shell.openPath 一致）。 */
  openPath?: (path: string) => Promise<string>
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
  const packaged = options.isPackaged ?? app.isPackaged
  const canInstall = canInstallUpdates(mode, packaged)
  const canReplace = canReplaceApp(mode, packaged)
  // electron-updater 自己查一次最新版本，得知道用户接不接预发布，否则它挑出来的
  // 可能和调度器报的不是同一个版本（甚至没有）。
  const download =
    options.download ?? (() => downloadWithUpdater(options.allowPrerelease?.() ?? false))
  const install = options.install ?? installWithUpdater
  /** macOS 上下载好的安装包；用户点了「打开安装包」才真的打开。 */
  let downloaded: DownloadedPackage | undefined
  /** 更新已经下载好，下次退出时安装（electron-updater 的 autoInstallOnAppQuit）。 */
  let ready = false

  /** 只提示：打开下载页。detail 用来解释为什么没走自动流程。 */
  const showDownloadPage = async (release: LatestRelease, detail?: string): Promise<void> => {
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
        detail: detail ?? labels.detail,
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

  /**
   * macOS：下载完整包，然后打开它让用户把应用拖进「应用程序」。
   * 没签名所以装不了（ADR 0005），但这样整条升级链路仍然在应用里走完，
   * 用户不需要自己去 Release 页面找对应架构的包。
   */
  const replaceInPlace = async (release: LatestRelease): Promise<void> => {
    const labels = updateLabels(app.getLocale())
    const fetchPackage =
      options.downloadPackage ??
      ((found: LatestRelease): Promise<DownloadedPackage> => {
        const asset = pickDmg(found.assets, options.arch ?? process.arch)
        if (!asset) throw new Error("no dmg asset for this architecture")
        return downloadPackage(asset)
      })
    try {
      downloaded = await fetchPackage(release)
    } catch (error) {
      console.warn("update download failed", error instanceof Error ? error.message : error)
      await showDownloadPage(release, labels.downloadFailed)
      return
    }
    const open = await ask({
      getWindow: options.getWindow,
      message: {
        type: "info",
        buttons: [labels.replace, labels.later],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: labels.replaceTitle.replace("{version}", release.version),
        detail: labels.replaceDetail,
      },
    })
    if (!open) return
    const packagePath = downloaded.path
    // shell.openPath 返回错误字符串而不是抛异常；它还可能一直不返回（Linux 会话总线不可用）。
    // 换包这条路径只需要把文件交给系统，等不到就当作已经交出去了。
    const result = options.openPath
      ? await options.openPath(packagePath)
      : await settleOpenPath(shell.openPath(packagePath))
    // 打不开就退回下载页：用户至少还能自己去 Release 页面拿。
    if (result) await showDownloadPage(release, labels.openFailed)
  }

  const prompt = async (release: LatestRelease): Promise<void> => {
    if (canInstall) {
      // 后台下载好，下次退出时安装；下载失败就退回下载页，别让用户没有出路。
      if (await download()) {
        ready = true
        await showReady(release.version)
        return
      }
      console.warn("update download failed")
    }
    if (canReplace) {
      await replaceInPlace(release)
      return
    }
    await showDownloadPage(release)
  }

  const scheduler = createUpdateScheduler({
    apiUrl: () => process.env.PIGCODE_UPDATE_API ?? RELEASES_API,
    // E2E 用 PIGCODE_UPDATE_CHECK=0 整个关掉。
    enabled: () => process.env.PIGCODE_UPDATE_CHECK !== "0",
    autoCheck: options.autoCheck,
    allowPrerelease: options.allowPrerelease ?? (() => false),
    currentVersion: () => app.getVersion(),
    prompt,
    log: (message) => console.warn(message),
    ...(options.fetchRelease ? { fetchRelease: options.fetchRelease } : {}),
    // E2E 把首次检查提前：默认的 5 秒既拖慢全量测试，又让断言和真实计时器赛跑。
  })
  return {
    start: () => scheduler.start(),
    checkNow: () => scheduler.checkNow(),
    installIfReady() {
      if (!ready) return false
      // 交给 electron-updater：它会走一遍退出，并在装好后重新打开应用。
      install()
      return true
    },
  }
}

/** 退出并安装已经下载好的更新，装完重新打开应用。 */
function installWithUpdater(): void {
  void import("electron-updater")
    .then(({ autoUpdater }) => {
      // isSilent=false：显示安装进度；isForceRunAfter=true：装完自动打开。
      autoUpdater.quitAndInstall(false, true)
    })
    .catch((error: unknown) => {
      console.warn("update install failed", error instanceof Error ? error.message : error)
    })
}

/** 下载更新。electron-updater 按 electron-builder 写进安装包的 app-update.yml 找源。 */
async function downloadWithUpdater(allowPrerelease: boolean): Promise<boolean> {
  try {
    const { autoUpdater } = await import("electron-updater")
    autoUpdater.autoDownload = false
    // 和调度器用同一个偏好：勾了「接收预发布版本」就要能装到预发布版。
    autoUpdater.allowPrerelease = allowPrerelease
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
