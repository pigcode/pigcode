/** M0-A 垂直切片：项目/线程、fake 流、Host 重启后的重连。 */
import { _electron as electron, expect, test } from "@playwright/test"

test("creates a project, streams a fake response, and reconnects", async () => {
  const app = await electron.launch({ args: ["."] })
  const page = await app.firstWindow()
  await page.fill("#root", "/tmp/pigcode-e2e")
  await page.click("#add")
  await page.click("#new")
  await page.fill("#text", "hello")
  await page.click("#send")
  await expect(page.locator("#messages")).toContainText("message.delta")
  await expect(page.locator("#messages")).toContainText("message.completed")

  // 通过测试 hook 杀掉 utilityProcess，窗口应保留并重连
  await app.evaluate(({ app }) => app.emit("pigcode:test-kill-host"))
  await expect(page.locator("#messages")).toContainText("reconnected")
  await app.close()
})
