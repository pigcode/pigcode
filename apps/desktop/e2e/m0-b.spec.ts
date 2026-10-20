/** M0-B 验收：项目/会话、fake 流、插件面板、重连。 */
import { _electron as electron, expect, test } from "@playwright/test"

test("chat, plugin panel, and reconnect", async () => {
  const app = await electron.launch({ args: ["."] })
  const page = await app.firstWindow()
  // 侧栏同时渲染图标按钮和空状态按钮，取第一个即可。
  await page.getByRole("button", { name: "添加项目" }).first().click()
  await page.getByLabel("项目路径").fill("/tmp/pigcode-m0b")
  await page.getByRole("button", { name: "添加", exact: true }).click()
  // 等待 project.add 的 RPC 返回并渲染到侧栏，再创建会话。
  await expect(page.getByText("pigcode-m0b", { exact: true })).toBeVisible()
  // 「新会话」同时出现在导航和项目行，取第一个导航入口。
  await page.getByRole("button", { name: "新会话" }).first().click()
  // 线程创建是异步 RPC；等 composer 可编辑后再输入。
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Hello from fake provider")).toBeVisible()

  await page.getByRole("button", { name: "设置", exact: true }).click()
  // 窗口侧栏与设置页各自有一套分区导航，取窗口侧栏的入口。
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const samplePlugin = new URL("../../../examples/ui-debug-panel", import.meta.url).pathname
  await page.getByLabel("插件目录").fill(samplePlugin)
  await page.getByRole("button", { name: "安装本地插件" }).click()
  await expect(page.getByText("Debug Panel")).toBeVisible()

  // 核心 profile 条目也会出现在插件列表里，按插件名定位到示例插件所在行。
  await page
    .locator(".item")
    .filter({ hasText: "pigcode-ui-debug-panel" })
    .getByRole("button", { name: "停用" })
    .click()
  await expect(page.getByText("Debug Panel")).toBeHidden()

  await app.evaluate(({ app }) => app.emit("pigcode:test-kill-host"))
  await expect(page.getByText("已重新连接")).toBeVisible()
  await app.close()
})
