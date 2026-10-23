/** 对 shell、聊天、设置、插件页做浅/深色截图。 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

/**
 * 启动应用并等待主题应用到根元素，避免截到主题切换前的画面。每次用一个空的用户 profile：
 * 前面的用例装过的插件会让列表变长、出现滚动条，页面跟着横移。
 */
async function launch(theme: "light" | "dark") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const profileDir = mkdtempSync(join(tmpdir(), "pigcode-visual-"))
  const app = await electron.launch({
    args: ["."],
    env: { ...env, PIGCODE_PROFILE_DIR: profileDir },
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: theme })
  await page.waitForSelector(".app")
  await page.waitForSelector(`html[data-theme="${theme}"]`)
  return { app, page }
}

for (const theme of ["light", "dark"] as const) {
  test(`shell ${theme}`, async () => {
    const { app, page } = await launch(theme)
    await expect(page).toHaveScreenshot(`shell-${theme}.png`, {
      maxDiffPixels: 0,
      animations: "disabled",
    })
    await app.close()
  })

  test(`settings and plugins ${theme}`, async () => {
    const { app, page } = await launch(theme)
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await expect(page.getByRole("heading", { name: "通用设置" })).toBeVisible()
    await expect(page).toHaveScreenshot(`settings-${theme}.png`, {
      maxDiffPixels: 0,
      animations: "disabled",
    })

    // 窗口侧栏与设置页各有一套分区导航，取窗口侧栏的入口。
    await page.getByRole("button", { name: "插件", exact: true }).first().click()
    await expect(page.getByRole("heading", { name: "插件管理" })).toBeVisible()
    // 已安装列表依赖 profile 状态；只截到页头（标题、说明、刷新与安装）下方，保证基线不受列表内容影响。
    const pageHead = page.locator(".settings-page .page-head").first()
    await expect(pageHead).toBeVisible()
    const box = await pageHead.boundingBox()
    if (!box) throw new Error("plugin page header has no layout box")
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    await expect(page).toHaveScreenshot(`plugins-${theme}.png`, {
      maxDiffPixels: 0,
      animations: "disabled",
      clip: {
        x: 0,
        y: 0,
        width: viewport.width,
        height: Math.min(viewport.height, Math.ceil(box.y + box.height + 24)),
      },
    })
    await app.close()
  })
}
