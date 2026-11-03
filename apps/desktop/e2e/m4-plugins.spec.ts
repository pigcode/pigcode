/** M4 验收：安装/启用/停用第三方 Agent、UI、Capability 插件。 */
import { mkdirSync, rmSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject, installPlugin } from "./projects"

test("installs, enables, and disables plugins without restart", async () => {
  // 每次从干净的项目目录开始，避免上一次失败残留影响结果。
  const projectRoot = "/tmp/pigcode-m4-e2e"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const app = await electron.launch({ args: ["."], env: { ...env, PIGCODE_AGENT: "echo" } })
  const page = await app.firstWindow()
  // 安装 Agent 插件
  await addProject(app, page, projectRoot)
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const agent = new URL("../../../examples/agent-echo", import.meta.url).pathname
  await installPlugin(page, agent)
  const echo = page.locator(".ext-item").filter({ hasText: "pigcode-agent-echo" })
  await expect(echo).toBeVisible()
  await expect(echo.getByRole("switch")).toBeChecked()
  // 设置页的侧栏和内容区各有一个返回入口，取侧栏那个。
  await page.getByRole("button", { name: "返回应用" }).first().click()

  // 新建会话，默认 agent 由 PIGCODE_AGENT=echo 强制
  await page.getByRole("button", { name: "新会话" }).first().click()
  // 线程创建是异步 RPC；等 composer 可编辑后再输入。
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello echo")
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: "hello echo" })).toBeVisible()
  // echo agent 把输入原样回传，确认插件提供的 agent 真的接管了这次 run。
  await expect(page.locator(".msg-ai").filter({ hasText: "hello echo" })).toBeVisible()

  // 安装 UI 插件：它的 Panel 出现在侧栏，Surface 出现在右侧面板的「+」菜单里。
  const openPlugins = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "插件", exact: true }).first().click()
  }
  const backToApp = () => page.getByRole("button", { name: "返回应用" }).first().click()
  await openPlugins()
  const ui = new URL("../../../examples/ui-debug-panel", import.meta.url).pathname
  await installPlugin(page, ui)
  const debug = page.locator(".ext-item").filter({ hasText: "pigcode-ui-debug-panel" })
  await expect(debug.getByRole("switch")).toBeChecked()
  const debugPanel = page.locator(".plugin-panel-head").filter({ hasText: "Debug Panel" })
  await expect(debugPanel).toBeVisible()
  await backToApp()
  await expect(debugPanel).toBeVisible()

  // 先开一个终端，再打开插件的 Surface：它成为当前标签，内容由插件画出。
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
  const tabs = page.locator(".right-panel").getByRole("tab")
  const addSurface = page.getByRole("button", { name: "添加面板" })
  await addSurface.click()
  await page.getByRole("menuitem", { name: /终端/ }).click()
  await expect(tabs).toHaveText(["终端 1"])
  await addSurface.click()
  await page.getByRole("menuitem", { name: "Debug Inspector" }).click()
  await expect(tabs).toHaveText(["终端 1", "Debug Inspector"])
  await expect(page.getByRole("tab", { name: "Debug Inspector" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.locator("[data-plugin-content='debug-inspector']")).toBeVisible()

  // 停用后 Panel 消失，打开着的 Surface 标签关闭，当前标签改选终端，「+」菜单里也不再有它。
  await openPlugins()
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).not.toBeChecked()
  await expect(debugPanel).toBeHidden()
  await backToApp()
  await expect(tabs).toHaveText(["终端 1"])
  await expect(page.getByRole("tab", { name: "终端 1" })).toHaveAttribute("aria-selected", "true")
  await expect(debugPanel).toHaveCount(0)
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: /终端/ })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Debug Inspector" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // 重新启用：Panel 与 Surface 回来。
  await openPlugins()
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).toBeChecked()
  await expect(debugPanel).toBeVisible()
  await backToApp()
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: "Debug Inspector" })).toBeVisible()
  await page.keyboard.press("Escape")
  await openPlugins()

  // Capability 插件没有可见 UI，用列表状态验证启停热生效；详情里是包名与类型。
  const capabilityPlugin = new URL("../../../examples/capability-session-info", import.meta.url)
    .pathname
  await installPlugin(page, capabilityPlugin)
  const capabilityItem = page
    .locator(".ext-item")
    .filter({ hasText: "pigcode-capability-session-info" })
  await expect(capabilityItem.getByRole("switch")).toBeChecked()
  await capabilityItem.getByRole("switch").click()
  await expect(capabilityItem.getByRole("switch")).not.toBeChecked()
  await expect(capabilityItem).toContainText("已停用")
  await capabilityItem.locator(".ext-row-main").click()
  await expect(capabilityItem.locator(".ext-facts")).toContainText("能力")

  await app.close()
})
