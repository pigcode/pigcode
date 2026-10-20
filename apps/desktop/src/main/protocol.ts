/** 注册 pigcode:// 与 pigcode-plugin://，并保证路径不越出根目录。 */
import { protocol } from "electron"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"

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

/** 把请求路径解析到根目录内；越界时抛出错误。 */
export function resolveInside(root: string, requestPath: string): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, normalize(requestPath))
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}/`)) {
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
      },
    })
  })
}

/** 提供 boot.json 与插件 client bundle；插件名经过 URL 编码。 */
export function registerPluginProtocol(profileDir: string): void {
  protocol.handle("pigcode-plugin", async (request) => {
    const url = new URL(request.url)
    if (url.hostname === "boot.json") {
      return new Response(await readFile(join(profileDir, "boot.json")), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      })
    }
    if (url.hostname !== "plugins") return new Response("not found", { status: 404 })
    const segments = url.pathname.split("/").filter(Boolean)
    const name = decodeURIComponent(segments[0] ?? "")
    const file = segments.slice(1).join("/")
    if (!name || !file) return new Response("not found", { status: 404 })
    const target = resolveInside(join(profileDir, "node_modules", name), file)
    return new Response(await readFile(target), {
      headers: {
        "content-type": file.endsWith(".css") ? "text/css" : "text/javascript",
        "access-control-allow-origin": "*",
      },
    })
  })
}
