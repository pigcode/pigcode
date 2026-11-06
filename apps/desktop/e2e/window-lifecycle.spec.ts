/** 关窗口只是隐藏（pigcode/monorepo#18）：macOS 和 Windows 上 Host 继续跑，从 Dock 或托盘能叫回来。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test.skip(process.platform === "linux", "Linux closes the last window and quits")

test("closing the window keeps the app and the Host running", async () => {
  const { app, page } = await openThread("lifecycle")
  try {
    // 先确认 Host 是通的。
    await page.locator(".tiptap").click()
    await page.keyboard.type("before")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Hello from fake agent")).toBeVisible({ timeout: 5000 })

    const visible = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect.poll(visible).toBe(false)
    // 窗口还在、应用还在运行：Host 和 agent 没有跟着退出。
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    // 点 Dock 图标（macOS 的 activate）把同一个窗口叫回来，Host 还是原来那个。
    await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"))
    await expect.poll(visible).toBe(true)
    await page.locator(".tiptap").click()
    await page.keyboard.type("after")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Hello from fake agent")).toHaveCount(2, { timeout: 5000 })
  } finally {
    await app.close()
  }
})
