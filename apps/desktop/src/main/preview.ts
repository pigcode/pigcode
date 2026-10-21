/** 本地预览窗口：只允许 loopback http/https，并在沙箱窗口中打开。 */
import { randomUUID } from "node:crypto"
import { BrowserWindow } from "electron"

/** 允许的 loopback 主机名；URL 会把 IPv6 主机规范化为带方括号的形式。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** 所有由本模块创建的预览窗口，按 id 索引。 */
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

/** 在独立沙箱窗口中打开 loopback URL，返回可用于关闭的 id。 */
export function openPreview(url: string): { id: string } {
  if (!isAllowedPreviewUrl(url)) throw new Error("PREVIEW_URL_NOT_ALLOWED")

  const id = randomUUID()
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  void window.loadURL(url)
  windows.set(id, window)
  window.on("closed", () => windows.delete(id))
  return { id }
}

/** 关闭指定预览窗口；省略 id 时关闭全部。 */
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
