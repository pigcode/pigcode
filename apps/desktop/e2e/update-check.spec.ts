/** 检查更新（pigcode/monorepo#67）：手动检查显示结果，打开下载页走系统浏览器；自动检查的开关存得住。 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { launchEnv, launchArgs } from "./projects"
import { releaseServer } from "./update-fixture"

test("a manual check shows the new version and can open the download page", async () => {
  const { url, server } = await releaseServer("v9.9.9")
  const app = await electron.launch({
    args: launchArgs(),
    // 关掉后台检查：这个用例只测手动检查，本地服务也回答不了和当前版本相同的情况。
    env: launchEnv({ PIGCODE_UPDATE_API: url, PIGCODE_UPDATE_CHECK: "0" }),
  })
  try {
    const page = await app.firstWindow()
    // 点「打开下载页」时不要真的打开浏览器，记下地址即可。
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedUrls: opened })
      shell.openExternal = (async (target: string) => {
        opened.push(target)
      }) as typeof shell.openExternal
    })
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).first().click()
    // 自动检查默认开。
    await expect(page.getByRole("switch", { name: "自动检查更新" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    // 接收预发布默认关：正式版用户不该被推到 beta 上。
    const prerelease = page.getByRole("switch", { name: "接收预发布版本" })
    await expect(prerelease).toHaveAttribute("aria-checked", "false")
    // 开关存进 profile，不是本机的 userData。
    await prerelease.click()
    await expect(prerelease).toHaveAttribute("aria-checked", "true")
    // 从测试进程读 profile 里的 preferences.json（主进程 evaluate 里没有 require）。
    const stored = (): Record<string, unknown> =>
      JSON.parse(
        readFileSync(join(process.env.PIGCODE_PROFILE_DIR ?? "", "preferences.json"), "utf8"),
      )
    await expect.poll(stored).toMatchObject({ prereleaseUpdates: true })

    await page.getByRole("button", { name: "立即检查" }).click()
    await expect(page.getByText("有新版本 9.9.9")).toBeVisible({ timeout: 10_000 })
    await page.locator(".page").getByRole("button", { name: "查看更新", exact: true }).click()
    await expect(page.locator(".update-center-popup")).toContainText("9.9.9")
    await page
      .locator(".update-center-popup")
      .getByRole("button", { name: "下载页", exact: true })
      .click()
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls),
      )
      .toEqual(["https://github.com/pigcode/pigcode/releases/tag/v9.9.9"])
  } finally {
    await app.close()
    server.close()
  }
})

test("the background check appears in the unified update entry", async () => {
  const { url, server } = await releaseServer("v9.9.9")
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ PIGCODE_UPDATE_API: url }),
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }) => {
      const prompts: string[] = []
      Object.assign(globalThis, { updatePrompts: prompts })
      dialog.showMessageBox = (async (
        windowOrOptions: unknown,
        maybeOptions?: { message: string },
      ) => {
        const options = maybeOptions ?? (windowOrOptions as { message: string })
        prompts.push(options.message)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    await page
      .locator(".window-controls")
      .getByRole("button", { name: "查看更新", exact: true })
      .click()
    await expect(page.locator(".update-center-popup")).toContainText("9.9.9")
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { updatePrompts: string[] }).updatePrompts,
      ),
    ).toEqual([])
  } finally {
    await app.close()
    server.close()
  }
})

test("a failed check says so and leaves the app alone", async () => {
  const { url, server } = await releaseServer(null)
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ PIGCODE_UPDATE_API: url, PIGCODE_UPDATE_CHECK: "0" }),
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).first().click()
    await page.getByRole("button", { name: "立即检查" }).click()
    await expect(page.getByText("检查失败，请稍后再试")).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
    server.close()
  }
})
