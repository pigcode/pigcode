/** M0 验收：Agent 检测卡住时，界面照常可用，不等检测结束。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("a stuck agent detection doesn't hold up the app", async () => {
  // 检测 15 秒才返回；界面在这期间必须能照常用。
  const { app, page } = await openThread("cold-start", { PIGCODE_FAKE_DETECT_MS: "15000" })

  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "Agent", exact: true }).first().click()
  // 检测进行中：按钮禁用，说明确实卡在检测上。
  await expect(page.getByRole("button", { name: "重新检测" })).toBeDisabled()

  // 设置页的其他分区照常能切，检测没有堵住界面。
  await page.getByRole("button", { name: "通用", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "通用", exact: true }).first()).toHaveAttribute(
    "aria-current",
    "page",
  )

  // 回到会话，消息照常发出并完成：没有等检测。
  await page.getByRole("button", { name: "返回应用" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Hello from fake agent")).toBeVisible({ timeout: 5000 })
  await app.close()
})
