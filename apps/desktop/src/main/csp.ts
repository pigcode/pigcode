/**
 * 渲染进程的 Content-Security-Policy（架构文档 §10.3；#19 在实验分支上逐项试过）。
 * 只在从 pigcode:// 加载的页面上生效。
 */
import { createHash } from "node:crypto"

/** 内联 <script>：属性里没有 src 的才是内联脚本。 */
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/**
 * 内联脚本的哈希。浏览器按正文原样算 sha256，所以这里也不能去掉首尾空白。
 * import map 是内联的，改了映射哈希就跟着变，不用手工维护常量。
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>()
  for (const match of html.matchAll(SCRIPT)) {
    const attributes = match[1] ?? ""
    const body = match[2] ?? ""
    if (/(^|\s)src\s*=/i.test(attributes) || body.trim() === "") continue
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`)
  }
  return [...hashes]
}

/**
 * 页面用的 CSP。script-src 里没有 'unsafe-inline'，内联脚本只能靠哈希放行。
 * style-src 留了 'unsafe-inline'：界面用 React 的 style 属性和运行时插入的样式表。
 * frame-src 放开 http(s)：内置浏览器用 <webview> 打开任意页面，预览用 iframe 打开 loopback 页面，
 * 范围由主进程的导航守卫限制，不靠 CSP。
 */
export function contentSecurityPolicy(html: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' pigcode-plugin: ${inlineScriptHashes(html).join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline' pigcode-plugin:",
    // 聊天的 Markdown 允许 http(s) 图片（markdown.tsx 的 safeImage），CSP 要跟它一致。
    "img-src 'self' data: http: https:",
    "connect-src 'self' pigcode-plugin:",
    "frame-src 'self' blob: http: https:",
    "object-src 'none'",
  ].join("; ")
}
