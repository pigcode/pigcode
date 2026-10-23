/** E2E 用的本地小站：一个登录表单和登录后的欢迎页。 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

const page = (title: string, body: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

const LOGIN = page(
  "Demo 登录",
  `<h1>登录 Demo</h1>
  <form id="form">
    <label for="email">邮箱</label><input id="email" type="email" />
    <label for="password">密码</label><input id="password" type="password" />
    <button type="submit">登录</button>
  </form>
  <script>
    document.getElementById("form").addEventListener("submit", (event) => {
      event.preventDefault()
      const email = document.getElementById("email").value
      location.href = "/welcome?email=" + encodeURIComponent(email)
    })
  </script>`,
)

/** 启动小站，返回地址与关闭函数。 */
export async function startDemoSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (url.pathname === "/welcome") {
      const email = (url.searchParams.get("email") ?? "").replace(/[<>&]/g, "")
      response.end(page("欢迎", `<h1>欢迎回来</h1><p>已登录：${email}</p>`))
      return
    }
    response.end(LOGIN)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
