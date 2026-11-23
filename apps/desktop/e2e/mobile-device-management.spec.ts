import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("shows the literal name and device number before revoking one of two same-named phones", async () => {
  const profile = mkdtempSync(join(tmpdir(), "pigcode-e2e-devices-"))
  const name = "个人 $& iPhone"
  const devices = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)]
  const [first, second] = devices.map((key) =>
    createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase(),
  )
  writeFileSync(
    join(profile, "settings.json"),
    JSON.stringify({
      "mobile.devices": devices.map((key, index) => ({
        publicKey: key.toString("base64url"),
        name,
        platform: "ios",
        lastConnectedAt: 2000,
        ...(index === 0 ? { reminders: { enabled: false, permission: "granted", syncedAt: 2000 } } : {}),
      })),
    }),
  )
  try {
    const { app, page } = await openThread("device-management", { PIGCODE_PROFILE_DIR: profile })
    try {
      await page.getByRole("button", { name: "设置", exact: true }).click()
      await page.getByRole("button", { name: "手机连接", exact: true }).click()
      const individual = page.getByRole("button", {
        name: "撤销「" + name + "」的配对（设备编号 " + first + "）",
      })
      const other = page.getByRole("button", {
        name: "撤销「" + name + "」的配对（设备编号 " + second + "）",
      })
      await expect(page.getByText(name, { exact: true })).toHaveCount(2)
      await expect(page.getByText("未连接", { exact: true })).toHaveCount(2)
      await expect(page.getByText(/iOS.*最近连接/)).toHaveCount(2)
      await expect(page.getByText(/推送未登记.*提醒设置同步于.*手机提醒已关闭/)).toHaveCount(1)
      await expect(page.getByText(/推送未登记.*等待手机同步提醒设置/)).toHaveCount(1)
      await individual.click()
      const confirm = page.getByRole("dialog", { name: "撤销配对" })
      await expect(confirm).toContainText(name)
      await expect(confirm).toContainText(first!)
      await confirm.getByRole("button", { name: "取消", exact: true }).click()
      await expect(individual).toBeVisible()
      await individual.click()
      await confirm.getByRole("button", { name: "确认撤销", exact: true }).click()
      await expect(confirm).toHaveCount(0)
      await expect(individual).toHaveCount(0)
      await expect(other).toBeVisible()
    } finally {
      await app.close()
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
