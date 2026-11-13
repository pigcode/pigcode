/** 应用更新服务。检查、下载和安装状态统一交给窗口里的更新入口。 */
import { app, shell } from "electron"
import type { DesktopUpdateState } from "@pigcode/contracts"
import { RELEASES_API, type LatestRelease, type fetchLatestRelease } from "./update-check"
import { downloadPackage, pickDmg, type DownloadedPackage } from "./update-download"
import { canInstallUpdates, canReplaceApp, updateMode, type UpdateMode } from "./update-mode"
import { createUpdateScheduler, type UpdateResult } from "./update-scheduler"
import { settleOpenPath } from "./open-in"

export type { UpdateResult } from "./update-scheduler"

export interface Updates {
  start(): void
  checkNow(): Promise<UpdateResult>
  getState(): DesktopUpdateState
  perform(): Promise<DesktopUpdateState>
  installIfReady(): boolean
}

export interface UpdateOptions {
  autoCheck: () => boolean
  allowPrerelease?: () => boolean
  mode?: UpdateMode
  isPackaged?: boolean
  requestRestart?: () => void
  onState?: (state: DesktopUpdateState) => void
  download?: (onProgress: (percent: number) => void) => Promise<boolean>
  install?: () => void | Promise<void>
  fetchRelease?: typeof fetchLatestRelease
  downloadPackage?: (release: LatestRelease) => Promise<DownloadedPackage>
  arch?: string
  openPath?: (path: string) => Promise<string>
}

export function createUpdates(options: UpdateOptions): Updates {
  const mode = options.mode ?? updateMode(process.platform, process.env)
  const packaged = options.isPackaged ?? app.isPackaged
  const canInstall = canInstallUpdates(mode, packaged)
  const canReplace = canReplaceApp(mode, packaged)
  const install = options.install ?? installWithUpdater
  let release: LatestRelease | null = null
  let downloaded: DownloadedPackage | null = null
  let ready = false
  let operation: Promise<DesktopUpdateState> | null = null
  let state: DesktopUpdateState = {
    autoCheck: options.autoCheck(),
    phase: "idle",
    currentVersion: app.getVersion(),
    version: null,
    url: null,
    action: null,
    progress: null,
    error: null,
  }
  const publish = (patch: Partial<DesktopUpdateState>) => {
    state = { ...state, ...patch }
    options.onState?.(state)
  }
  const foundUpdate = (found: LatestRelease | null | "error") => {
    // 下载和待安装状态绑定到已经选定的版本。
    if (operation || ready || downloaded) return
    if (found === "error") {
      publish({ phase: "failed", error: "check" })
      return
    }
    release = found
    const canDownload =
      canInstall ||
      (canReplace &&
        Boolean(
          options.downloadPackage || (found && pickDmg(found.assets, options.arch ?? process.arch)),
        ))
    publish(
      found
        ? {
            phase: "available",
            version: found.version,
            url: found.url,
            action: canDownload ? "download" : "open-release",
            progress: null,
            error: null,
          }
        : { phase: "idle", version: null, url: null, action: null, progress: null, error: null },
    )
  }
  const scheduler = createUpdateScheduler({
    apiUrl: () => process.env.PIGCODE_UPDATE_API ?? RELEASES_API,
    enabled: () => process.env.PIGCODE_UPDATE_CHECK !== "0",
    autoCheck: options.autoCheck,
    allowPrerelease: options.allowPrerelease ?? (() => false),
    currentVersion: () => app.getVersion(),
    prompt: async () => undefined,
    onChecked: foundUpdate,
    log: (message) => console.warn(message),
    ...(options.fetchRelease ? { fetchRelease: options.fetchRelease } : {}),
  })

  async function perform(): Promise<DesktopUpdateState> {
    if (!release || !state.action) return state
    const action = state.action
    publish({ error: null })
    try {
      if (action === "restart") {
        ;(options.requestRestart ?? (() => app.quit()))()
        publish({ phase: "ready" })
      } else if (action === "open-package" && downloaded) {
        const error = options.openPath
          ? await options.openPath(downloaded.path)
          : await settleOpenPath(shell.openPath(downloaded.path))
        if (error) throw new Error(error)
        publish({ phase: "ready" })
      } else if (action === "open-release") {
        await shell.openExternal(release.url)
        publish({ phase: "available" })
      } else if (action === "download") {
        const selected = release
        publish({ phase: "downloading", progress: null })
        const onProgress = (value: number) =>
          publish({ progress: Math.max(0, Math.min(100, value)) })
        if (canInstall) {
          const download =
            options.download ??
            ((progress) => downloadWithUpdater(options.allowPrerelease?.() ?? false, progress))
          if (!(await download(onProgress))) throw new Error("Update download failed")
          ready = true
          publish({ phase: "ready", action: "restart", progress: 100 })
        } else {
          const fetchPackage =
            options.downloadPackage ??
            ((found: LatestRelease) => {
              const asset = pickDmg(found.assets, options.arch ?? process.arch)
              if (!asset) throw new Error("No installation package for this architecture")
              return downloadPackage(asset, fetch, onProgress)
            })
          downloaded = await fetchPackage(selected)
          publish({ phase: "ready", action: "open-package", progress: 100 })
        }
      }
    } catch {
      publish({
        phase: "failed",
        error: action === "download" ? "download" : action === "restart" ? "install" : "open",
      })
    }
    return state
  }

  return {
    start() {
      publish({ autoCheck: options.autoCheck() })
      scheduler.start()
    },
    getState: () => state,
    async checkNow() {
      if (operation || ready || downloaded) {
        return release
          ? { status: "update-available", version: release.version, url: release.url }
          : { status: "up-to-date" }
      }
      publish({ phase: "checking", error: null })
      return scheduler.checkNow()
    },
    perform() {
      operation ??= perform().finally(() => {
        operation = null
      })
      return operation
    },
    installIfReady() {
      if (!ready) return false
      try {
        void Promise.resolve(install()).catch(() => publish({ phase: "failed", error: "install" }))
      } catch {
        publish({ phase: "failed", error: "install" })
        return false
      }
      return true
    },
  }
}

async function installWithUpdater(): Promise<void> {
  const { autoUpdater } = await import("electron-updater")
  autoUpdater.quitAndInstall(false, true)
}

async function downloadWithUpdater(
  allowPrerelease: boolean,
  onProgress: (percent: number) => void,
): Promise<boolean> {
  const { autoUpdater } = await import("electron-updater")
  const progress = (value: { percent: number }) => onProgress(value.percent)
  autoUpdater.on("download-progress", progress)
  try {
    autoUpdater.autoDownload = false
    autoUpdater.allowPrerelease = allowPrerelease
    autoUpdater.autoInstallOnAppQuit = true
    const result = await autoUpdater.checkForUpdates()
    if (!result) return false
    await autoUpdater.downloadUpdate()
    return true
  } finally {
    autoUpdater.removeListener("download-progress", progress)
  }
}
