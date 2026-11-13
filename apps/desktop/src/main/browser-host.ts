/**
 * 把内置浏览器接进 main：渲染进程登记 webview、Host 经控制端口发来 agent 动作、
 * 以及所有 webview 的安全限制（沙箱、无 preload、独立分区、只允许 http/https）。
 */
import {
  app,
  ipcMain,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type MessagePortMain,
} from "electron"
import { BrowserAgent, type BrowserRequest, type GuestContents } from "./browser-agent"
import {
  BROWSER_PARTITION,
  isAllowedBrowserUrl,
  readBrowserExternalUrl,
  readBrowserWebUrl,
} from "./browser-policy"

function isBrowserRequest(value: unknown): value is BrowserRequest {
  if (typeof value !== "object" || value === null) return false
  const request = value as Partial<BrowserRequest>
  return (
    request.type === "browser.request" &&
    typeof request.id === "number" &&
    typeof request.threadId === "string" &&
    typeof request.action === "string"
  )
}

/** 收紧 webview 的配置并限制它能去的地址。 */
function guardWebviews(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, preferences, params) => {
      delete preferences.preload
      preferences.nodeIntegration = false
      preferences.nodeIntegrationInSubFrames = false
      preferences.contextIsolation = true
      preferences.sandbox = true
      preferences.webSecurity = true
      if (
        params.partition !== BROWSER_PARTITION ||
        (params.src && !isAllowedBrowserUrl(params.src))
      ) {
        event.preventDefault()
      }
    })
    if (contents.getType() !== "webview") return
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    contents.on("will-redirect", (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    // 新窗口在同一个标签里打开，内置浏览器只有标签没有弹窗。
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) void contents.loadURL(url).catch(() => undefined)
      return { action: "deny" }
    })
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
  })
}

/** 内置浏览器在 main 里的入口；Host 每次（重新）启动都把控制端口交给它。 */
export interface BrowserHost {
  attachControlPort(port: MessagePortMain): void
}

/** 注册 IPC 与安全限制；getWindow 返回当前主窗口。 */
export function setupBrowser(getWindow: () => BrowserWindow | undefined): BrowserHost {
  const send = (channel: string, payload: unknown) => {
    const window = getWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
  const agent = new BrowserAgent({
    requestOpen: (threadId, url) => send("pigcode:browser-open", { threadId, url }),
    notifyActivity: (activity) => send("pigcode:browser-activity", activity),
    contentsFor: (id) => webContents.fromId(id) as GuestContents | undefined,
  })
  guardWebviews()
  ipcMain.handle(
    "pigcode:browser-register",
    (event, sessionId: unknown, threadId: unknown, contentsId: unknown) => {
      if (typeof sessionId !== "string" || typeof threadId !== "string") return
      if (typeof contentsId !== "number") return
      // 只接受挂在发起方窗口里的 webview，页面不能拿任意 webContents 冒充浏览器。
      const guest = webContents.fromId(contentsId)
      if (!guest || guest.getType() !== "webview" || guest.hostWebContents !== event.sender) return
      agent.register(sessionId, threadId, contentsId)
    },
  )
  ipcMain.handle("pigcode:browser-unregister", (_event, sessionId: unknown) => {
    if (typeof sessionId === "string") agent.unregister(sessionId)
  })
  // 本机的 http 开发服务器也能用系统浏览器打开；邮件地址交给系统的邮件应用。
  ipcMain.handle("pigcode:browser-external", async (_event, value: unknown) => {
    const url = readBrowserExternalUrl(value)
    if (!url) throw new Error("URL_NOT_ALLOWED")
    await shell.openExternal(url)
  })
  ipcMain.handle("pigcode:browser-save-link", (_event, value: unknown) => {
    const url = readBrowserWebUrl(value)
    if (!url) throw new Error("URL_NOT_ALLOWED")
    // 让 Electron 根据响应头和 URL 建议文件名，并显示系统保存对话框。
    session.fromPartition(BROWSER_PARTITION).downloadURL(url)
  })
  return {
    attachControlPort(port) {
      port.on("message", (event) => {
        if (!isBrowserRequest(event.data)) return
        void agent.handle(event.data).then((response) => port.postMessage(response))
      })
      port.start()
    },
  }
}
