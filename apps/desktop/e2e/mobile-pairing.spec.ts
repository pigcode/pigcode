import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

test("shows a one-time pairing QR and invalidates it on leaving settings", async () => {
  test.skip(!address || !token, "A WSS relay fixture is required")
  if (!address || !token) return
  const { app, page } = await openThread("mobile-pairing")
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    const phoneSettings = page.getByRole("button", { name: "手机连接", exact: true })
    await phoneSettings.click()
    await page.getByLabel("中继地址").fill(address)
    await page.getByLabel("访问令牌").fill(token)
    await page.getByRole("button", { name: "测试并保存" }).click()
    await expect(page.getByText("中继连接测试通过，配置已保存。")).toBeVisible()

    await page.getByRole("button", { name: "配对手机", exact: true }).click()
    const qr = page.getByRole("img", { name: "手机配对二维码" })
    await expect(qr).toBeVisible()
    await expect(page.getByText("二维码剩余有效期")).toBeVisible()
    const initial = await qr.getAttribute("src")
    await page.getByRole("button", { name: "取消配对" }).click()
    await expect(qr).toHaveCount(0)
    await expect(page.getByText("已取消配对。")).toBeVisible()

    await page.getByRole("button", { name: "配对手机", exact: true }).click()
    await expect(qr).toBeVisible()
    await expect(qr).not.toHaveAttribute("src", initial ?? "")
    await page.getByRole("button", { name: "外观", exact: true }).first().click()
    await phoneSettings.click()
    await expect(page.getByText("已取消配对。")).toBeVisible()
    await expect(qr).toHaveCount(0)
  } finally {
    await app.close()
  }
})
