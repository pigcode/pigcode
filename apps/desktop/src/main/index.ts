/** Electron main：单实例、窗口、Host utilityProcess、原生桥与端口转交。 */
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron"
import { join } from "node:path"
import { startHostProcess, type HostProcess } from "./host-process"
import { registerAppProtocol, registerPluginProtocol, registerPrivilegedSchemes } from "./protocol"
import { closePreview, openPreview } from "./preview"
import { createMainWindowOptions, readThemeSource } from "./window-options"

registerPrivilegedSchemes()

let host: HostProcess | undefined
let mainWindow: BrowserWindow | undefined
let quitting = false

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
    }),
  )
  window.once("ready-to-show", () => window.show())
  window.webContents.on("did-finish-load", () => {
    if (host) window.webContents.postMessage("pigcode:port", null, [host.appPort])
  })
  await window.loadURL("pigcode://app/index.html")
  return window
}

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

app.on("before-quit", () => {
  quitting = true
  host?.stop()
})

app.on("window-all-closed", () => {
  quitting = true
  host?.stop()
  app.quit()
})
