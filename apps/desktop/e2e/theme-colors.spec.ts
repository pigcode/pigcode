/** 主题颜色验收：终端配色由 --term-* token 生成，强调色与明暗变化后不重开终端也跟着变。 */
import { expect, test, type Page } from "@playwright/test"
import { openThread } from "./projects"

/** xterm 当前用的光标色：DOM 渲染器把它写进自己的样式表。 */
function cursorColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const css = Array.from(document.querySelectorAll("style"), (item) => item.textContent).join("")
    return /xterm-cursor-block \{ background-color: ([^;]+);/.exec(css)?.[1]?.toUpperCase() ?? ""
  })
}

/** xterm 当前用的终端底色：写在滚动容器的内联样式上。 */
function backgroundColor(page: Page): Promise<string> {
  return page
    .locator(".terminal-view .xterm-scrollable-element")
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor)
}

/** 把 <html> 上某个 token 的计算值画进 1×1 画布读出像素；Chromium 的计算值保留 oklch，不能直接读。 */
function paintedColor(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext("2d")
  if (!ctx) return ""
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase()
}

test("terminal colours follow the theme tokens", async () => {
  const { app, page } = await openThread("theme-colors")
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light"
  })
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
  await page.getByLabel("打开一个面板").getByRole("button", { name: /终端/ }).click()
  await expect(page.locator(".xterm")).toBeVisible()

  // 默认光标就是强调色 --primary 在画布上的像素值
  const accent = await page.evaluate(paintedColor, "--primary")
  expect(accent).toMatch(/^#[0-9A-F]{6}$/)
  await expect.poll(() => cursorColor(page)).toBe(accent)
  await expect.poll(() => backgroundColor(page)).toBe("rgb(255, 255, 255)")

  // 外观设置换强调色时就是把它写到 <html> 的 --primary 上
  await page.evaluate(() => document.documentElement.style.setProperty("--primary", "#D97757"))
  await expect.poll(() => cursorColor(page)).toBe("#D97757")

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark"
  })
  await expect.poll(() => backgroundColor(page)).toBe("rgb(22, 22, 22)")
  await expect.poll(() => cursorColor(page)).toBe("#D97757")

  await app.close()
})

test("the native title bar follows the Appearance mode", async () => {
  const { app, page } = await openThread("title-bar")
  // 换掉主进程的处理函数，记下页面上报的颜色；macOS 上主进程本来会忽略这条消息
  await app.evaluate(({ ipcMain }) => {
    const reports: unknown[] = []
    Object.assign(globalThis, { titleBarReports: reports })
    ipcMain.removeHandler("pigcode:title-bar")
    ipcMain.handle("pigcode:title-bar", (_event, value: unknown) => {
      reports.push(value)
    })
  })
  const lastReport = () =>
    app.evaluate(() => {
      const { titleBarReports } = globalThis as { titleBarReports?: unknown[] }
      return titleBarReports?.at(-1) ?? null
    })

  // 页面自己的窗口底色（body 与 .titlebar 都用 --window），macOS 浅色下是平台覆盖后的值
  const pageWindow = () => page.evaluate(paintedColor, "--window")

  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "外观", exact: true }).first().click()
  const mode = page.getByRole("radiogroup", { name: "模式" })
  // 启动时已按系统明暗上报过一次，颜色相同的不会重报；先切到浅色，后面每一步都是真的变化
  await mode.getByRole("radio", { name: "浅色" }).click()
  await expect(mode.getByRole("radio", { name: "浅色" })).toBeChecked()
  await mode.getByRole("radio", { name: "深色" }).click()
  await expect.poll(lastReport).toEqual({ color: "#0D0D0D", symbolColor: "#CACACC" })
  await expect.poll(pageWindow).toBe("#0D0D0D")
  await mode.getByRole("radio", { name: "浅色" }).click()
  await expect.poll(lastReport).toMatchObject({ symbolColor: "#3F3F46" })
  expect(await lastReport()).toEqual({ color: await pageWindow(), symbolColor: "#3F3F46" })

  // 外观设置存在共用的 profile 里，改回默认，免得影响之后启动的用例
  await mode.getByRole("radio", { name: "跟随系统" }).click()
  await expect(mode.getByRole("radio", { name: "跟随系统" })).toBeChecked()
  await app.close()
})
