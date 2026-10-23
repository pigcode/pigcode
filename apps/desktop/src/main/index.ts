/** Electron main：单实例、窗口、Host utilityProcess、原生桥与端口转交。 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MessageBoxSyncOptions,
} from "electron"
import { join } from "node:path"
import {
  pickFolder,
  pickPath,
  readExternalUrl,
  readFolderPickerLabels,
  readPathKind,
} from "./folder-picker"
import { startHostProcess, type HostProcess } from "./host-process"
import { popupNativeMenu, readMenuPosition, readNativeMenu } from "./native-menu"
import { appIcon } from "./app-icons"
import { appDefsFor, detectApps } from "./open-apps"
import {
  launchCommand,
  launchDetached,
  readDirectory,
  readExistingPath,
  settleOpenPath,
  type OpenAppInfo,
} from "./open-in"
import { setupBrowser } from "./browser-host"
import { registerAppProtocol, registerPluginProtocol, registerPrivilegedSchemes } from "./protocol"
import { closePreview, isAllowedPreviewUrl, openPreview } from "./preview"
import {
  DEFAULT_UNSAVED_LABELS,
  confirmDiscard,
  readUnsavedGuardLabels,
  type UnsavedGuardLabels,
} from "./unsaved-guard"
import {
  TITLE_BAR_HEIGHT,
  createMainWindowOptions,
  readThemeSource,
  readTitleBarColors,
  usesTitleBarOverlay,
} from "./window-options"

registerPrivilegedSchemes()

let host: HostProcess | undefined
let mainWindow: BrowserWindow | undefined
let quitting = false
let unsavedLabels: UnsavedGuardLabels = DEFAULT_UNSAVED_LABELS
const browser = setupBrowser(() => mainWindow)

/** 把应用内相对路径解析到 app.getAppPath() 之下。 */
export function resolveAppPath(...segments: string[]): string {
  return join(app.getAppPath(), ...segments)
}

function profileDir(): string {
  return process.env.PIGCODE_PROFILE_DIR ?? join(app.getPath("userData"), "profiles", "desktop")
}

/** 注册主题与窗口控制 IPC；只接受已知的动作和外观值。 */
function registerNativeBridge(): void {
  ipcMain.handle("pigcode:set-theme", (_event, value: unknown) => {
    const source = readThemeSource(value)
    if (source) nativeTheme.themeSource = source
  })
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
  // 原生窗口按钮的底色与图标色跟随页面当前外观；macOS 的交通灯不需要。
  ipcMain.handle("pigcode:title-bar", (event, value: unknown) => {
    const colors = readTitleBarColors(value)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!colors || !window || !usesTitleBarOverlay(process.platform)) return
    window.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT })
  })
  // 标题栏菜单由页面描述、主进程弹出原生菜单；返回被点击的命令 id。
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
  ipcMain.handle("pigcode:unsaved-labels", (_event, value: unknown) => {
    unsavedLabels = readUnsavedGuardLabels(value) ?? unsavedLabels
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

registerNativeBridge()

function startHost(): HostProcess {
  const next = startHostProcess(resolveAppPath("out/host/index.mjs"), profileDir())
  browser.attachControlPort(next.controlPort)
  next.child.on("exit", () => {
    if (quitting) return
    host = startHost()
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.postMessage("pigcode:port", null, [host.appPort])
    }
  })
  return next
}

/** 创建调试窗口，并在页面加载后把 Host 的 MessagePort 交给渲染进程。 */
export async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(
    createMainWindowOptions({
      platform: process.platform,
      preloadPath: resolveAppPath("out/preload/index.cjs"),
      isPackaged: app.isPackaged,
      dark: nativeTheme.shouldUseDarkColors,
    }),
  )
  window.once("ready-to-show", () => window.show())
  // macOS 全屏时交通灯隐藏，页面据此收回为交通灯预留的空间。
  window.on("enter-full-screen", () => window.webContents.send("pigcode:full-screen", true))
  window.on("leave-full-screen", () => window.webContents.send("pigcode:full-screen", false))
  // 右侧浏览器用 iframe 内嵌本机页面；子框架的跳转与重定向同样只能留在 loopback。
  const guardFrame = (event: { isMainFrame: boolean; url: string; preventDefault: () => void }) => {
    if (!event.isMainFrame && /^https?:/i.test(event.url) && !isAllowedPreviewUrl(event.url)) {
      event.preventDefault()
    }
  }
  window.webContents.on("will-frame-navigate", guardFrame)
  window.webContents.on("will-redirect", guardFrame)
  // 页面有未保存的文件修改时会阻止卸载；preventDefault 表示用户确认放弃，继续关闭或刷新。
  window.webContents.on("will-prevent-unload", (event) => {
    const show = (options: MessageBoxSyncOptions) => dialog.showMessageBoxSync(window, options)
    if (confirmDiscard(show, unsavedLabels)) event.preventDefault()
  })
  window.webContents.on("did-finish-load", () => {
    if (host) window.webContents.postMessage("pigcode:port", null, [host.appPort])
  })
  await window.loadURL("pigcode://app/index.html")
  return window
}

/**
 * 默认 profile 只允许一个实例：两个 Host 同时读写一份数据库与 settings.json 会互相覆盖。
 * 再次启动时把已有窗口带到前台后退出。显式指定 PIGCODE_PROFILE_DIR（E2E、并排的多个 profile）不加锁。
 */
const singleInstance = process.env.PIGCODE_PROFILE_DIR === undefined
if (singleInstance && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(async () => {
    registerAppProtocol(resolveAppPath("out/renderer"))
    registerPluginProtocol(profileDir())
    host = startHost()
    mainWindow = await createWindow()

    if (process.env.PIGCODE_E2E === "1") {
      app.on("pigcode:test-kill-host" as never, () => {
        host?.stop()
      })
    }
  })
}

// 窗口都关掉以后才停 Host：退出时窗口可能因为未保存的修改被用户留下，退出随之取消。
app.on("will-quit", () => {
  quitting = true
  host?.stop()
})

app.on("window-all-closed", () => {
  quitting = true
  host?.stop()
  app.quit()
})
