/** 右栏内置浏览器：agent 通过 MCP 工具操作它，用户能看到并自己使用（fake agent）。 */
import { expect, test, type ElectronApplication } from "@playwright/test"
import { startDemoSite } from "./demo-site"
import { openThread } from "./projects"

/** 读取 guest 页面上的文字；webview 的内容只在 main 里拿得到。 */
function guestText(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview")
    return guest ? String(await guest.executeJavaScript("document.body.innerText")) : ""
  })
}

test("the agent logs in on a local page in the built-in browser", async () => {
  const site = await startDemoSite()
  const { app, page } = await openThread("browser-agent", { PIGCODE_FAKE_STEP_MS: "300" })
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type(`browser ${site.url}`)
    await page.keyboard.press("Enter")

    // agent 打开浏览器时右栏自动展开，webview 盖在浏览器标签上。
    await expect(page.locator(".browser-hosted[data-shown]")).toBeVisible()
    // 标签先显示主机名，页面加载后换成页面标题。
    await expect(
      page.getByRole("tab", { name: new RegExp(`${new URL(site.url).host}|Demo 登录|欢迎`) }),
    ).toHaveAttribute("aria-selected", "true")
    await expect(page.locator('.browser-toast[data-tone="agent"]')).toBeVisible()

    await expect(page.locator(".msg-ai").filter({ hasText: "登录流程正常" })).toBeVisible({
      timeout: 30_000,
    })
    await expect.poll(() => guestText(app)).toContain("已登录：demo@pigcode.dev")
    // 文字直接打进页面，不会落到应用自己的输入框里。
    await expect(page.locator(".tiptap")).toHaveText("")
    await expect(page.locator(".browser-address input")).toHaveValue(/\/welcome\?email=demo/)
    await expect(page.locator('.browser-toast[data-tone="agent"]')).toHaveCount(0, {
      timeout: 5_000,
    })

    // 时间线：浏览器步骤合成分组，截图默认展开。
    await page.getByRole("button", { name: /已工作/ }).click()
    const groups = page.locator(".tool-group").filter({ hasText: "浏览器" })
    await expect(groups).toHaveCount(2)
    await groups.last().locator(".tool-row-head").first().click()
    await expect(groups.last().locator(".tool-row-images img")).toHaveAttribute(
      "src",
      /^data:image\/jpeg;base64,/,
    )
  } finally {
    await app.close()
    await site.close()
  }
})

test("people can browse in the same browser tab with the address bar", async () => {
  const site = await startDemoSite()
  const { app, page } = await openThread("browser-user")
  try {
    await page.getByRole("button", { name: "切换右侧面板" }).first().click()
    await page
      .getByRole("button", { name: /浏览器/ })
      .first()
      .click()
    const address = page.locator(".browser-address input")
    await address.fill(new URL(site.url).host)
    await address.press("Enter")
    await expect.poll(() => guestText(app)).toContain("登录 Demo")
    await expect(page.locator(".browser-hosted[data-shown]")).toBeVisible()

    await address.fill(`${site.url}welcome?email=me`)
    await address.press("Enter")
    await expect.poll(() => guestText(app)).toContain("已登录：me")
    await page.locator(".browser-toolbar").getByRole("button", { name: "后退" }).click()
    await expect.poll(() => guestText(app)).toContain("登录 Demo")

    // 不允许的协议在地址栏就被拦下。
    await address.fill("file:///etc/passwd")
    await address.press("Enter")
    await expect(page.locator(".browser-error")).toHaveText("只支持 http/https 网址")

    // 标签显示页面标题；响应式视图按设备尺寸渲染页面。
    await expect(page.getByRole("tab", { name: "Demo 登录" })).toBeVisible()
    await page.getByRole("button", { name: "响应式视图" }).click()
    await expect(page.locator(".browser-hosted[data-responsive][data-shown]")).toBeVisible()
    await expect
      .poll(() =>
        app.evaluate(async ({ webContents }) => {
          const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview")
          return guest ? Number(await guest.executeJavaScript("innerWidth")) : 0
        }),
      )
      .toBe(393)
    await page.getByRole("button", { name: "退出响应式视图" }).click()
    await expect(page.locator(".browser-hosted[data-responsive]")).toHaveCount(0)

    // 选择网页元素：点中登录按钮，它作为附件出现在输入框上方。
    await page.getByRole("button", { name: "选择网页元素加入聊天" }).click()
    await expect(page.locator('.browser-toast[data-tone="picker"]')).toBeVisible()
    const box = await page.locator(".browser-hosted[data-shown]").boundingBox()
    const target = await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview")
      return guest?.executeJavaScript(
        `(() => { const r = document.querySelector("button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
      ) as Promise<{ x: number; y: number }>
    })
    await page.mouse.move(box!.x + target.x, box!.y + target.y, { steps: 4 })
    await page.mouse.click(box!.x + target.x, box!.y + target.y)
    await expect(page.locator(".composer-context")).toContainText("<button> 登录")
    await expect(page.locator('.browser-toast[data-tone="done"]')).toContainText("已加入聊天")
    // 加入后光标去输入框，下一帧才落下；先等它落定，否则地址栏失焦会丢掉刚填的地址。
    await expect(page.locator(".tiptap")).toBeFocused()

    // 打不开的地址：页面区说明原因，可以重新加载。
    await address.fill("http://127.0.0.1:9/")
    await address.press("Enter")
    await expect(page.locator('.browser-state[data-state="error"]')).toContainText(
      "无法打开这个网页",
    )
  } finally {
    await app.close()
    await site.close()
  }
})
