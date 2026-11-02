/** M0-B 验收：项目/会话、fake 流、插件的侧栏面板与右栏标签、重连。 */
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject, installPlugin } from "./projects"

test("chat, plugin panel, and reconnect", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const app = await electron.launch({
    args: ["."],
    env: { ...env, PIGCODE_AGENT: "fake" },
  })
  const page = await app.firstWindow()
  await addProject(app, page, "/tmp/pigcode-m0b")
  // 等待 project.add 的 RPC 返回并渲染到侧栏，再创建会话。
  await expect(page.getByText("pigcode-m0b", { exact: true })).toBeVisible()
  // 「新会话」同时出现在导航和项目行，取第一个导航入口。
  await page.getByRole("button", { name: "新会话" }).first().click()
  // 线程创建是异步 RPC；等 composer 可编辑后再输入。
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello")
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: "hello" })).toBeVisible()
  await expect(page.getByText("Hello from fake agent")).toBeVisible()

  await page.getByRole("button", { name: "设置", exact: true }).click()
  // 窗口侧栏与设置页各自有一套分区导航，取窗口侧栏的入口。
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const samplePlugin = new URL("../../../examples/ui-debug-panel", import.meta.url).pathname
  await installPlugin(page, samplePlugin)
  await expect(page.getByText("Debug Panel")).toBeVisible()

  // 插件的右栏标签和内置标签一样列在启动器里，内容用宿主的控件与 pg-* 排版。
  await page.getByRole("button", { name: "返回应用" }).first().click()
  await page.getByRole("button", { name: "切换右侧面板" }).first().click()
  await page.getByRole("button", { name: "Debug Inspector" }).click()
  await expect(page.getByRole("tab", { name: "Debug Inspector" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  const surface = page.locator(".pg-root.pg-surface")
  await expect(surface.locator(".pg-section-title").first()).toHaveText("宿主")
  await surface.locator(".btn.btn-primary").filter({ hasText: "读取项目" }).click()
  await expect(surface.locator(".pg-list-title")).toContainText(["pigcode-m0b"])

  // 核心 profile 条目也会出现在插件列表里，按插件包名定位到示例插件所在行。
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const row = page.locator(".ext-item").filter({ hasText: "pigcode-ui-debug-panel" })
  await expect(row.getByRole("switch")).toBeChecked()
  await row.getByRole("switch").click()
  await expect(page.getByText("Debug Panel")).toBeHidden()

  await app.evaluate(({ app }) => app.emit("pigcode:test-kill-host"))
  await expect(page.getByText("已重新连接")).toBeVisible()
  await app.close()
})
