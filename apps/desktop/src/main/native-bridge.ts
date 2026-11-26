/** 主进程原生桥 IPC：窗口控制、菜单、文件对话框、更新、偏好、外链、打开应用与预览窗口。 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron"
import { appIcon } from "./app-icons"
import { preferencesPath } from "./app-paths"
import { registerAppearanceIpc } from "./appearance-ipc"
import {
  pickFolder,
  pickPath,
  readExternalUrl,
  readFolderPickerLabels,
  readPathKind,
} from "./folder-picker"
import { popupNativeMenu, readMenuPosition, readNativeMenu } from "./native-menu"
import { appDefsFor, detectApps } from "./open-apps"
import {
  launchCommand,
  launchDetached,
  readDirectory,
  readExistingPath,
  settleOpenPath,
  type OpenAppInfo,
} from "./open-in"
import { withPreference, writePreferences, type Preferences } from "./preferences"
import { closePreview, openPreview } from "./preview"
import { readUnsavedGuardLabels, type UnsavedGuardLabels } from "./unsaved-guard"
import type { Updates } from "./updates"

export interface NativeBridgeDeps {
  updates: Pick<Updates, "checkNow" | "getState" | "perform" | "start">
  getPreferences: () => Preferences
  applyPreferences: (next: Preferences) => void
  setUnsavedLabels: (labels: UnsavedGuardLabels) => void
}

/** 注册主题与窗口控制 IPC；只接受已知的动作和外观值。 */
export function registerNativeBridge(deps: NativeBridgeDeps): void {
  // 设置页显示的版本就是 package.json 的版本，electron 在启动时读一次。
  ipcMain.handle("pigcode:app-version", () => app.getVersion())

  ipcMain.handle("pigcode:window", (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (action === "minimize") window.minimize()
    else if (action === "maximize") {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (action === "close") window.close()
  })
  ipcMain.handle("pigcode:is-maximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
  ipcMain.handle("pigcode:is-full-screen", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  })
  registerAppearanceIpc(ipcMain, BrowserWindow, nativeTheme, {
    platform: process.platform,
    systemVersion: process.getSystemVersion(),
    downloads: () => app.getPath("downloads"),
    showSaveDialog: (parent, options) => dialog.showSaveDialog(parent, options),
  })
  // 页面描述菜单项和位置，主进程弹出原生菜单并返回被点击的命令 id。
  ipcMain.handle("pigcode:menu", (event, items: unknown, position: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const menu = readNativeMenu(items, { allowDevRoles: !app.isPackaged })
    const at = readMenuPosition(position)
    if (!window || !menu || !at) return null
    const zoom = event.sender.getZoomFactor()
    return popupNativeMenu(Menu, window, menu, { x: at.x * zoom, y: at.y * zoom })
  })
  // 创建项目时用系统文件管理器选择源文件夹；返回路径，取消时为 null。
  ipcMain.handle("pigcode:pick-folder", (event, labels: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    return pickFolder(
      (parent, options) => dialog.showOpenDialog(parent, options),
      window,
      readFolderPickerLabels(labels),
    )
  })
  // agent 设置里选可执行文件或配置目录；kind 之外的值直接拒绝。
  ipcMain.handle("pigcode:pick-path", (event, kind: unknown, labels: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const pathKind = readPathKind(kind)
    if (!window || !pathKind) return null
    return pickPath(
      (parent, options) => dialog.showOpenDialog(parent, options),
      window,
      pathKind,
      readFolderPickerLabels(labels),
    )
  })
  ipcMain.handle("pigcode:check-for-updates", () => deps.updates.checkNow())
  ipcMain.handle("pigcode:update-state", () => deps.updates.getState())
  ipcMain.handle("pigcode:update-action", () => deps.updates.perform())
  ipcMain.handle("pigcode:preferences-get", () => deps.getPreferences())
  ipcMain.handle("pigcode:preferences-set", (_event, key: unknown, value: unknown) => {
    const current = deps.getPreferences()
    const next = withPreference(current, key, value)
    if (next === current) return current
    writePreferences(preferencesPath(), next)
    deps.applyPreferences(next)
    // 自动检查的开关改了，定时器跟着起停。
    // 这两个都影响「该不该把一个版本当成新版本」，改了要重新排一次检查。
    if (key === "autoCheckUpdates" || key === "prereleaseUpdates") deps.updates.start()
    return next
  })
  ipcMain.handle("pigcode:unsaved-labels", (_event, value: unknown) => {
    const parsed = readUnsavedGuardLabels(value)
    if (parsed) deps.setUnsavedLabels(parsed)
  })
  // 外部链接（agent 官网）交给系统浏览器；只接受不带凭据的 https。
  ipcMain.handle("pigcode:open-external", async (_event, value: unknown) => {
    const url = readExternalUrl(value)
    if (!url) throw new Error("URL_NOT_ALLOWED")
    await shell.openExternal(url)
  })
  // 文件树的「在文件管理器中显示」：只接受已存在的绝对路径。
  ipcMain.handle("pigcode:reveal-path", (_event, value: unknown) => {
    const path = readExistingPath(value)
    if (!path) throw new Error("PATH_NOT_FOUND")
    shell.showItemInFolder(path)
  })
  // 项目文件夹交给系统文件管理器打开；页面只能传已存在的目录。
  ipcMain.handle("pigcode:open-folder", async (_event, value: unknown) => {
    const folder = readDirectory(value)
    if (!folder) throw new Error("FOLDER_NOT_FOUND")
    const error = await settleOpenPath(shell.openPath(folder))
    if (error) throw new Error(error)
  })
  // 本机装了的文件管理器、编辑器与终端；每次打开菜单都重新检测，图标按位置缓存。
  ipcMain.handle("pigcode:list-open-apps", async (): Promise<OpenAppInfo[]> => {
    const readIcon = (path: string) => app.getFileIcon(path, { size: "normal" })
    return Promise.all(
      detectApps(appDefsFor()).map(async (detected) => ({
        id: detected.def.id,
        name: detected.def.name,
        kind: detected.def.kind,
        icon: await appIcon(detected, readIcon),
      })),
    )
  })
  ipcMain.handle("pigcode:open-with-app", async (_event, appId: unknown, value: unknown) => {
    const folder = readDirectory(value)
    if (!folder) throw new Error("FOLDER_NOT_FOUND")
    const detected = detectApps(appDefsFor()).find((item) => item.def.id === appId)
    if (!detected) throw new Error("APP_NOT_FOUND")
    const launch = launchCommand(detected, folder)
    if (!launch) {
      const error = await settleOpenPath(shell.openPath(folder))
      if (error) throw new Error(error)
      return
    }
    await launchDetached(launch.command, launch.args, folder)
  })
  // 预览窗口：URL 合法性由 preview.ts 统一校验，IPC 只做类型收敛。
  ipcMain.handle("pigcode:preview-open", (_event, url: unknown) => {
    if (typeof url !== "string") throw new Error("PREVIEW_URL_NOT_ALLOWED")
    return openPreview(url)
  })
  ipcMain.handle("pigcode:preview-close", (_event, id: unknown) => {
    if (typeof id === "string") closePreview(id)
    else if (id === undefined || id === null) closePreview()
  })
}
