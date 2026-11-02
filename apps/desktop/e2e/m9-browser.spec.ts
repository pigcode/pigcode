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
    await expect(page.getByRole("tab", { name: new URL(site.url).host })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect(page.locator(".browser-agent")).toBeVisible()

    await expect(page.locator(".msg-ai").filter({ hasText: "登录流程正常" })).toBeVisible({
      timeout: 30_000,
    })
    await expect.poll(() => guestText(app)).toContain("已登录：demo@pigcode.dev")
    // 文字直接打进页面，不会落到应用自己的输入框里。
    await expect(page.locator(".tiptap")).toHaveText("")
    await expect(page.locator(".browser-address input")).toHaveValue(/\/welcome\?email=demo/)
    await expect(page.locator(".browser-agent")).toHaveCount(0, { timeout: 5_000 })

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
  } finally {
    await app.close()
    await site.close()
  }
})
