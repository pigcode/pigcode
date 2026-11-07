/** 内置浏览器的地址：补全地址栏输入、判断能不能打开，以及地址栏左边的连接类型。 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"])

/** 判断地址能否在内置浏览器里打开：只允许 http/https。 */
export function isBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * 把地址栏输入补全为完整 URL：「3000」→ http://localhost:3000，「localhost:5173/a」与 IP 补 http://，
 * 其他主机名补 https://。不是 http/https 时返回 null。
 */
export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim()
  if (value.length === 0) return null
  let candidate = value
  const hasScheme =
    /^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
    /^(about|javascript|data|file|mailto|blob|chrome|devtools|pigcode|pigcode-plugin):/i.test(value)
  if (/^\d{2,5}(\/.*)?$/.test(value)) candidate = `http://localhost:${value}`
  else if (!hasScheme) {
    const host = value.split(/[/?#]/)[0]?.replace(/:\d+$/, "").toLowerCase() ?? ""
    const local = LOCAL_HOSTS.has(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)
    candidate = `${local ? "http" : "https"}://${value}`
  }
  try {
    const url = new URL(candidate)
    return isBrowserUrl(url.href) ? url.href : null
  } catch {
    return null
  }
}

/** 本机地址：预览窗口只能打开这些。 */
export function isLocalBrowserUrl(value: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** 地址栏左边的连接类型：https 是安全连接，其他 http 地址不加密；本机地址不提示。 */
export function connectionOf(value: string): "secure" | "insecure" | "local" | null {
  if (!isBrowserUrl(value)) return null
  if (isLocalBrowserUrl(value)) return "local"
  return value.startsWith("https:") ? "secure" : "insecure"
}
