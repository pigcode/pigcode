/**
 * 通用设置里的开机自启和 Dock 图标（pigcode/pigcode#66）：开关的状态存进 profile，重启后还在。
 * Dock 图标是否真的从 Dock 里消失，Playwright 启动的 Electron 里 app.dock.isVisible() 一直返回 true，
 * 自动化测不出来，发布前手动确认一次。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { launchEnv } from "./projects"

test.skip(process.platform === "linux", "Linux hides the launch-at-login and Dock switches")

const preferencesFile = () => join(process.env.PIGCODE_PROFILE_DIR ?? "", "preferences.json")
const stored = () => JSON.parse(readFileSync(preferencesFile(), "utf8"))

test("the Dock switch is saved and survives a restart", async () => {
  let app = await electron.launch({ args: ["."], env: launchEnv({}) })
  let page = await app.firstWindow()
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).first().click()

    const dock = page.getByRole("switch", { name: "在 Dock 中显示" })
    await expect(dock).toHaveAttribute("aria-checked", "true")
    // 开机自启默认关。
    await expect(page.getByRole("switch", { name: "开机自动启动" })).toHaveAttribute(
      "aria-checked",
      "false",
    )

    await dock.click()
    await expect(dock).toHaveAttribute("aria-checked", "false")
    // 存进了 profile，不是本机的 userData。
    await expect.poll(stored).toMatchObject({ showInDock: false })
    await expect.poll(stored).toMatchObject({ launchAtLogin: false })
  } finally {
    await app.close()
  }

  // 重启后还是上次的选择。
  app = await electron.launch({ args: ["."], env: launchEnv({}) })
  page = await app.firstWindow()
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).first().click()
    await expect(page.getByRole("switch", { name: "在 Dock 中显示" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
  } finally {
    await app.close()
  }
})
