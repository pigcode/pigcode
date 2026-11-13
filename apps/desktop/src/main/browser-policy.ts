/**
 * 内置浏览器能打开的地址：http/https 与 about:blank。file:、javascript:、data:、应用自己的
 * pigcode: 等协议一律拒绝；页面运行在独立分区的沙箱 webview 里，没有 preload，碰不到 Node 与 IPC。
 */

/** 内置浏览器使用的独立会话分区；登录状态与应用本身隔离。 */
export const BROWSER_PARTITION = "persist:pigcode-browser"

/** 判断地址能否在内置浏览器里打开。 */
export function isAllowedBrowserUrl(value: string): boolean {
  if (value === "about:blank") return true
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === "http:" || url.protocol === "https:"
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"])

/**
 * 把 agent 或地址栏给的地址补全：「3000」「localhost:5173/a」补成 http，其他主机名补成 https。
 * 无法补全或协议不允许时返回 null。
 */
export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (value === "about:blank") return value
  let candidate = value
  // 「localhost:3000」看起来也像「协议:…」，只有带 // 或已知的单冒号协议才算写了协议。
  const hasScheme =
    /^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
    /^(about|javascript|data|file|mailto|blob|chrome|devtools|pigcode|pigcode-plugin):/i.test(value)
  if (/^\d{2,5}(\/.*)?$/.test(value)) candidate = `http://localhost:${value}`
  else if (!hasScheme) {
    const host = value.split(/[/?#]/)[0]?.replace(/:\d+$/, "").toLowerCase() ?? ""
    candidate = `${LOOPBACK.has(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? "http" : "https"}://${value}`
  }
  try {
    const url = new URL(candidate)
    return isAllowedBrowserUrl(url.href) ? url.href : null
  } catch {
    return null
  }
}

/** 浏览器打开或保存的网页地址，拒绝 URL 中的用户名和密码。 */
export function readBrowserWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "about:blank" || !isAllowedBrowserUrl(value))
    return null
  const url = new URL(value)
  return url.username || url.password ? null : url.toString()
}

/** 交给系统处理的链接。邮件链接继续使用系统的邮件应用。 */
export function readBrowserExternalUrl(value: unknown): string | null {
  if (typeof value === "string" && /^mailto:/i.test(value)) {
    try {
      return new URL(value).href
    } catch {
      return null
    }
  }
  return readBrowserWebUrl(value)
}
