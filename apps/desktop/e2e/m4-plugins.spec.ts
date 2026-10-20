/** M4 验收：安装/启用/停用第三方 provider、UI、capability 插件。 */
import { mkdirSync, rmSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"

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
  const app = await electron.launch({ args: ["."], env: { ...env, PIGCODE_PROVIDER: "echo" } })
  const page = await app.firstWindow()
  // 安装 provider 插件
  await page.getByRole("button", { name: "添加项目" }).first().click()
  await page.getByLabel("项目路径").fill(projectRoot)
  await page.getByRole("button", { name: "添加", exact: true }).click()
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const provider = new URL("../../../examples/provider-echo", import.meta.url).pathname
  await page.getByLabel("插件目录或 npm 包").fill(provider)
  await page.getByRole("button", { name: "安装插件" }).click()
  await expect(
    page.locator(".item").filter({ hasText: "pigcode-provider-echo" }).first(),
  ).toBeVisible()
  await expect(
    page
      .locator(".item")
      .filter({ hasText: "pigcode-provider-echo" })
      .getByRole("button", { name: "停用" }),
  ).toBeVisible()
  // 设置页的侧栏和内容区各有一个返回入口，取侧栏那个。
  await page.getByRole("button", { name: "返回应用" }).first().click()

  // 新建会话，默认 provider 由 PIGCODE_PROVIDER=echo 强制
  await page.getByRole("button", { name: "新会话" }).first().click()
  // 线程创建是异步 RPC；等 composer 可编辑后再输入。
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello echo")
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: "hello echo" })).toBeVisible()
  // echo provider 把输入原样回传，确认插件 provider 真的接管了这次 run。
  await expect(page.locator(".msg-ai").filter({ hasText: "hello echo" })).toBeVisible()

  // 安装 UI 插件，面板出现；停用后消失
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const ui = new URL("../../../examples/ui-debug-panel", import.meta.url).pathname
  await page.getByLabel("插件目录或 npm 包").fill(ui)
  await page.getByRole("button", { name: "安装插件" }).click()
  await expect(
    page
      .locator(".item")
      .filter({ hasText: "pigcode-ui-debug-panel" })
      .getByRole("button", { name: "停用" }),
  ).toBeVisible()
  await expect(page.getByText("Debug Panel")).toBeVisible()
  await page
    .locator(".item")
    .filter({ hasText: "pigcode-ui-debug-panel" })
    .getByRole("button", { name: "停用" })
    .click()
  await expect(page.getByText("Debug Panel")).toBeHidden()

  // capability 插件没有可见 UI，用列表状态验证启停热生效。
  const capability = new URL("../../../examples/capability-session-info", import.meta.url).pathname
  await page.getByLabel("插件目录或 npm 包").fill(capability)
  await page.getByRole("button", { name: "安装插件" }).click()
  const capabilityItem = page
    .locator(".item")
    .filter({ hasText: "pigcode-capability-session-info" })
  await expect(capabilityItem.getByRole("button", { name: "停用" })).toBeVisible()
  await capabilityItem.getByRole("button", { name: "停用" }).click()
  await expect(capabilityItem.getByRole("button", { name: "启用" })).toBeVisible()

  await app.close()
})
