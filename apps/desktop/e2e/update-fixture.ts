import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * 假的 Release 列表接口。返回数组：`/releases/latest` 按 GitHub 的定义永远不返回
 * 预发布，所以客户端读的是列表，挑哪一条由「接收预发布版本」的偏好决定。
 */
export async function releaseServer(tag: string | null): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url !== "/releases" || tag === null) {
      response.writeHead(404).end("not found")
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify([
        {
          tag_name: tag,
          html_url: `https://github.com/pigcode/pigcode/releases/tag/${tag}`,
          draft: false,
          prerelease: false,
          // macOS 走「下载完整包」时要用它挑这个架构的 DMG。
          assets: [
            {
              name: `Pigcode-${tag.replace(/^v/, "")}-arm64.dmg`,
              browser_download_url: `https://example.invalid/Pigcode-${tag.replace(/^v/, "")}-arm64.dmg`,
            },
          ],
        },
      ]),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}/releases`, server }
}
