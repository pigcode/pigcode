/** Electron main：单实例、窗口、Host utilityProcess 与端口转交。 */
import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import { startHostProcess, type HostProcess } from "./host-process"
import { registerAppProtocol, registerPluginProtocol, registerPrivilegedSchemes } from "./protocol"

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

function startHost(): HostProcess {
  const next = startHostProcess(resolveAppPath("out/host/index.mjs"), profileDir())
  next.child.on("exit", () => {
    if (quitting) return
    host = startHost()
    if (mainWindow) mainWindow.webContents.postMessage("pigcode:port", null, [host.appPort])
  })
  return next
}

/** 创建调试窗口，并在页面加载后把 Host 的 MessagePort 交给渲染进程。 */
export async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: resolveAppPath("out/preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
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
