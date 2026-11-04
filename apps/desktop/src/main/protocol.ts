/** 注册 pigcode:// 与 pigcode-plugin://，并保证路径不越出根目录。 */
import { protocol } from "electron"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, resolve, sep } from "node:path"

/** 常见静态资源扩展名对应的 MIME 类型。 */
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
}

/**
 * 实验（pigcode/pigcode#19）：在架构文档 §10.3 的 CSP 基础上，按探针收集到的拦截逐项放行。
 * 只在 experiment/csp 分支上启用，用来找出能让全部用例通过的最小集合；不合并。
 */
const EXPERIMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' pigcode-plugin: 'sha256-iLXpQ9XBWgPLh1LManhXVesg6ELUr8GwQfusHG0DCMs='",
  "style-src 'self' 'unsafe-inline' pigcode-plugin:",
  "img-src 'self' data:",
  "connect-src 'self' pigcode-plugin:",
].join("; ")

/** 把请求路径解析到根目录内；越界时抛出错误。 */
export function resolveInside(root: string, requestPath: string): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, normalize(requestPath))
  // 用平台分隔符比较：Windows 上 resolve 返回反斜杠路径。
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`path escapes root: ${requestPath}`)
  }
  return target
}

/** 必须在 app ready 之前调用。 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "pigcode",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: "pigcode-plugin",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ])
}

/** app ready 之后注册应用静态资源协议。 */
export function registerAppProtocol(appRoot: string): void {
  protocol.handle("pigcode", async (request) => {
    const url = new URL(request.url)
    const requestPath = decodeURIComponent(url.pathname).replace(/^\/+/, "")
    const file = resolveInside(appRoot, requestPath === "" ? "index.html" : requestPath)
    return new Response(await readFile(file), {
      headers: {
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
        "content-security-policy": EXPERIMENT_CSP,
      },
    })
  })
}

/** 文件不存在时返回 null；其他读错误照常抛出。 */
async function readIfExists(
  path: string,
  read: (path: string) => Promise<Buffer<ArrayBuffer>>,
): Promise<Buffer<ArrayBuffer> | null> {
  try {
    return await read(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * 处理一次 pigcode-plugin:// 请求：boot.json 与插件 client bundle；插件名经过 URL 编码。
 * 新 profile 里 Host 还没写出 boot.json 时返回空的启动图，而不是让请求失败。
 */
export async function handlePluginRequest(
  profileDir: string,
  requestUrl: string,
  read: (path: string) => Promise<Buffer<ArrayBuffer>> = (path) => readFile(path),
): Promise<Response> {
  const url = new URL(requestUrl)
  const cors = { "access-control-allow-origin": "*" }
  if (url.hostname === "boot.json") {
    const body = await readIfExists(join(profileDir, "boot.json"), read)
    return new Response(body ?? JSON.stringify({ entries: [] }), {
      headers: { "content-type": "application/json", ...cors },
    })
  }
  if (url.hostname !== "plugins") return new Response("not found", { status: 404, headers: cors })
  const segments = url.pathname.split("/").filter(Boolean)
  const name = decodeURIComponent(segments[0] ?? "")
  const file = segments.slice(1).join("/")
  if (!name || !file) return new Response("not found", { status: 404, headers: cors })
  let target: string
  try {
    target = resolveInside(join(profileDir, "node_modules", name), file)
  } catch {
    return new Response("forbidden", { status: 403, headers: cors })
  }
  const body = await readIfExists(target, read)
  if (!body) return new Response("not found", { status: 404, headers: cors })
  return new Response(body, {
    headers: { "content-type": file.endsWith(".css") ? "text/css" : "text/javascript", ...cors },
  })
}

/** app ready 之后注册插件协议。 */
export function registerPluginProtocol(profileDir: string): void {
  protocol.handle("pigcode-plugin", (request) => handlePluginRequest(profileDir, request.url))
}
