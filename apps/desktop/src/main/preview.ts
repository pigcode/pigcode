/**
 * 预览窗口：把本地开发服务器的页面放到独立的沙箱窗口打开。只允许 loopback 地址，
 * 与 M5 的验收一致（内置浏览器的 http/https 地址规则不适用于预览窗口）。
 */
import { randomUUID } from "node:crypto"
import { BrowserWindow, type WebContents } from "electron"
import { BROWSER_PARTITION } from "./browser-policy"

/** 允许的 loopback 主机名；URL 会把 IPv6 主机规范化为带方括号的形式。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** 所有由本模块创建的预览窗口（含弹窗），按 id 索引。 */
const windows = new Map<string, BrowserWindow>()

/** 判断 URL 是否指向本机 http/https；解析失败、其他协议或远程主机都返回 false。 */
export function isAllowedPreviewUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return LOOPBACK_HOSTS.has(url.hostname)
}

/** 记下窗口，previewClose 可以一起关掉它；返回用于关闭的 id。 */
function remember(window: BrowserWindow, id = randomUUID()): string {
  windows.set(id, window)
  window.on("closed", () => windows.delete(id))
  return id
}

/**
 * 给预览窗口装上地址限制，弹窗创建后递归应用同一套规则：
 * 主框架跳转、302、子框架导航和 window.open 都只能留在本机。
 */
function guardPreview(contents: WebContents): void {
  contents.on("will-navigate", (event, target) => {
    if (!isAllowedPreviewUrl(target)) event.preventDefault()
  })
  contents.on("will-redirect", (event, target) => {
    if (!isAllowedPreviewUrl(target)) event.preventDefault()
  })
  // will-navigate 只管主框架；子框架的初始地址与跳转走这里，与主窗口对 iframe 的规则一致。
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && /^https?:/i.test(event.url) && !isAllowedPreviewUrl(event.url)) {
      event.preventDefault()
    }
  })
  // about:blank 是本地页面常用的空白弹窗；它之后的跳转仍受上面的限制。
  contents.setWindowOpenHandler(({ url: target }) =>
    isAllowedPreviewUrl(target) || target === "about:blank"
      ? { action: "allow" }
      : { action: "deny" },
  )
  contents.on("did-create-window", (window) => {
    remember(window)
    guardPreview(window.webContents)
  })
}

/** 在独立沙箱窗口中打开本机页面，返回可用于关闭的 id。 */
export function openPreview(url: string): { id: string } {
  if (!isAllowedPreviewUrl(url)) throw new Error("PREVIEW_URL_NOT_ALLOWED")

  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: BROWSER_PARTITION,
    },
  })
  guardPreview(window.webContents)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  void window.loadURL(url)
  return { id: remember(window) }
}

/** 关闭指定预览窗口；省略 id 时关闭全部（包括它们弹出的窗口）。 */
export function closePreview(id?: string): void {
  if (id !== undefined) {
    const window = windows.get(id)
    windows.delete(id)
    if (window && !window.isDestroyed()) window.close()
    return
  }

  for (const [key, window] of windows) {
    windows.delete(key)
    if (!window.isDestroyed()) window.close()
  }
}
