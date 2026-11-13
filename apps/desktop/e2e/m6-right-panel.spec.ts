/** 右侧面板验收：多标签 surface、内置浏览器（webview）的地址规则、最大化与底部终端。 */
import { mkdirSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test"
import { addProject, launchArgs } from "./projects"
import { expectTerminalText, terminalText } from "./terminal"

/** 在 guest 页面里执行脚本；webview 的内容只在 main 里拿得到。 */
function inGuest(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview")
    return guest ? String(await guest.executeJavaScript(code)) : ""
  }, script)
}

const heading = (app: ElectronApplication) =>
  inGuest(app, "document.querySelector('h1')?.textContent ?? ''")

/** 过滤 undefined，满足 Playwright env 的 string 值约束。 */
function launchEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

/** 本机页面：首页链接到同源第二页，第二页有一个指向 file: 的链接。 */
function startSite(): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (request.url === "/second") {
      response.end('<h1>second page</h1><a id="out" href="file:///etc/passwd">leave</a>')
      return
    }
    response.end('<h1>local home</h1><a id="in" href="/second">next</a>')
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

test("right panel surfaces, embedded browser, maximize and bottom terminal", async () => {
  const projectRoot = "/tmp/pigcode-m6-e2e"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const site = await startSite()
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  const app = await electron.launch({
    args: launchArgs(),
    env: { ...launchEnv(), PIGCODE_AGENT: "fake" },
  })
  try {
    const page = await app.firstWindow()
    await addProject(app, page, projectRoot)
    await page
      .locator(".proj-block")
      .filter({ hasText: "pigcode-m6-e2e" })
      .locator(".proj-add")
      .click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    // 先发一条消息建好会话：这个用例看的是标签按会话保存（草稿里的右栏见 draft-workspace.spec.ts）。
    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello" })).toBeVisible()

    // 底部终端始终与「打开」同在聊天顶部，右栏展开只迁移右栏自己的按钮。
    const header = page.locator(".panel-top")
    const terminalToggle = header.getByRole("button", { name: "切换底部终端" })
    const terminalButton = await terminalToggle.elementHandle()
    await header.getByRole("button", { name: "切换右侧面板" }).click()
    const bar = page.locator(".right-panel-bar")
    await expect(page.getByLabel("打开一个面板")).toBeVisible()
    await expect(bar.getByRole("button", { name: "切换右侧面板" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(header.getByRole("button", { name: "切换右侧面板" })).toHaveCount(0)
    await expect(terminalToggle).toBeVisible()
    expect(
      await terminalToggle.evaluate((button, before) => button === before, terminalButton),
    ).toBe(true)
    await expect(bar.getByRole("button", { name: "切换底部终端" })).toHaveCount(0)

    // 焦点不在输入框时，单键 B 打开浏览器。
    await page.locator(".right-panel-body").click({ position: { x: 8, y: 8 } })
    await page.keyboard.press("b")
    await expect(page.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true")

    // 地址栏只接受 http/https；页面在 webview 里加载，标签标题换成主机名。
    const address = page.getByRole("textbox", { name: /输入网址/ })
    await address.fill("file:///etc/passwd")
    await address.press("Enter")
    await expect(page.getByRole("alert")).toContainText("只支持 http/https 网址")
    await address.fill(base)
    await address.press("Enter")
    await expect.poll(() => heading(app)).toBe("local home")
    await expect(page.locator(".browser-hosted[data-shown]")).toBeVisible()
    await expect(page.getByRole("tab", { name: new URL(base).host })).toBeVisible()

    // 页面内的跳转放行，跳去 file: 被主进程拦下，页面留在原地。
    await inGuest(app, "document.querySelector('#in').click()")
    await expect.poll(() => heading(app)).toBe("second page")
    await inGuest(app, "document.querySelector('#out').click()")
    await page.waitForTimeout(800)
    await expect.poll(() => heading(app)).toBe("second page")
    expect(await inGuest(app, "location.protocol")).toBe("http:")

    // 再开两个终端标签：序号递增；切到终端时 webview 移开，切回来页面还在原地。
    const tabs = page.locator(".right-panel").getByRole("tab")
    await page.getByRole("button", { name: "添加面板" }).click()
    await page.getByRole("menuitem", { name: /终端/ }).click()
    await expect(page.locator(".surface-pane:not([hidden]) .xterm")).toBeVisible()
    await expect(page.locator(".browser-hosted[data-shown]")).toHaveCount(0)
    await page.getByRole("button", { name: "新建终端" }).click()
    await expect(tabs).toHaveText([new URL(base).host, "终端 1", "终端 2"])
    await page.getByRole("tab", { name: new URL(base).host }).click()
    await expect(page.locator(".browser-hosted[data-shown]")).toBeVisible()
    await expect.poll(() => heading(app)).toBe("second page")

    // 标签按线程保存：新会话草稿各记各的开关，进来时右栏收起；打开后是草稿自己的空面板（不建会话），
    // 显示启动器；切回来后浏览器还是离开时的页面，没有重新加载。
    await page
      .locator(".proj-block")
      .filter({ hasText: "pigcode-m6-e2e" })
      .locator(".proj-add")
      .click()
    await expect(page.locator(".new-thread-view")).toBeVisible()
    await expect(page.locator(".right-panel")).toBeHidden()
    await expect(header.getByRole("button", { name: "切换右侧面板" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    await header.getByRole("button", { name: "切换右侧面板" }).click()
    await expect(page.getByLabel("打开一个面板")).toBeVisible()
    await expect(page.locator(".browser-hosted[data-shown]")).toHaveCount(0)
    await page.locator('.sess:not([aria-current="page"])').click()
    await expect(tabs).toHaveText([new URL(base).host, "终端 1", "终端 2"])
    await page.getByRole("tab", { name: new URL(base).host }).click()
    await expect.poll(() => heading(app)).toBe("second page")
    await expect(page.getByRole("textbox", { name: /输入网址/ })).toHaveValue(`${base}/second`)

    // 关闭当前标签激活右侧邻居。
    await page.getByRole("button", { name: `关闭 ${new URL(base).host}` }).click()
    await expect(page.getByRole("tab", { name: "终端 1" })).toHaveAttribute("aria-selected", "true")

    // 最大化时聊天区隐藏，还原后回来。
    await bar.getByRole("button", { name: "最大化面板" }).click()
    await expect(page.locator(".app")).toHaveClass(/is-right-max/)
    await expect(page.locator("main.panel")).toBeHidden()
    await bar.getByRole("button", { name: "还原面板大小" }).click()
    await expect(page.locator("main.panel")).toBeVisible()
    await bar.getByRole("button", { name: "最大化面板" }).click()
    await page.keyboard.press("Control+Backquote")
    await expect(page.locator("main.panel")).toBeVisible()
    const drawer = page.getByRole("region", { name: "底部终端" })
    await expect(drawer).toBeVisible()
    await terminalToggle.click()
    await expect(drawer).toBeHidden()

    // 收起右栏后标签仍在；⌃` 打开底部终端并能执行命令，再按一次隐藏。
    await bar.getByRole("button", { name: "切换右侧面板" }).click()
    await expect(page.locator(".right-panel")).toBeHidden()
    await page.keyboard.press("Control+Backquote")
    await expect(drawer.locator(".xterm")).toBeVisible()
    await drawer.locator(".xterm").click()
    await page.keyboard.type("echo DRAWER_OK")
    await page.keyboard.press("Enter")
    await expectTerminalText(drawer.locator(".xterm"), "DRAWER_OK")

    // 底部终端可以开多个：新标签是另一个 shell，切回第一个时它的输出还在。
    const termTabs = drawer.getByRole("tab")
    await expect(termTabs).toHaveCount(1)
    await drawer.getByRole("button", { name: "新建终端" }).click()
    await expect(termTabs).toHaveCount(2)
    await expect(termTabs.nth(1)).toHaveAttribute("aria-selected", "true")
    const second = drawer.locator(".terminal-pane:not([hidden]) .xterm")
    await expect(second).toBeVisible()
    expect(await terminalText(second)).not.toContain("DRAWER_OK")
    await second.click()
    await page.keyboard.type("exit")
    await page.keyboard.press("Enter")
    // shell 自己退出时关掉它的标签，回到第一个终端。
    await expect(termTabs).toHaveCount(1)
    await expectTerminalText(drawer.locator(".terminal-pane:not([hidden]) .xterm"), "DRAWER_OK")
    await expect(header.getByRole("button", { name: "切换底部终端" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await page.keyboard.press("Control+Backquote")
    await expect(drawer).toBeHidden()

    await header.getByRole("button", { name: "切换右侧面板" }).click()
    await expect(tabs).toHaveText(["终端 1", "终端 2"])
  } finally {
    await app.close()
    site.close()
  }
})
