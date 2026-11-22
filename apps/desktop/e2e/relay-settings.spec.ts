import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

test("tests and saves a Go relay over WSS from Phone Connections", async () => {
  test.skip(!address || !token, "A WSS relay fixture is required")
  if (!address || !token) return

  const { app, page } = await openThread("relay-settings")
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "手机连接", exact: true }).click()
    const endpoint = page.getByLabel("中继地址")
    const credential = page.getByLabel("访问令牌")
    const save = page.getByRole("button", { name: "测试并保存" })
    await endpoint.fill(address)
    await credential.fill(token)
    await save.click()
    await expect(page.getByText("中继连接测试通过，配置已保存。", { exact: true })).toBeVisible()
    await expect(credential).toHaveValue("")
    await expect(credential).toHaveAttribute("placeholder", "已配置")

    await credential.fill("pigcode-wss-check-wrong-token")
    await save.click()
    await expect(page.getByText(/中继拒绝了访问令牌/)).toBeVisible()
    await page.getByRole("button", { name: "外观", exact: true }).first().click()
    await page.getByRole("button", { name: "手机连接", exact: true }).click()
    await expect(endpoint).toHaveValue(address)
    await expect(credential).toHaveValue("")
    await expect(credential).toHaveAttribute("placeholder", "已配置")
    await save.click()
    await expect(page.getByText("中继连接测试通过，配置已保存。", { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
