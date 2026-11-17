/** Agent 插件：内置 Claude Code 与 Codex、设置页的表单与保存、启停、安装与卸载第三方 agent、跨重启保留。 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test, type Page } from "@playwright/test"
import { addProject, installPlugin, launchEnv, openThread, launchArgs } from "./projects"

/** 打开「设置 → Agent」。 */
async function openAgents(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "Agent", exact: true }).first().click()
  await expect(page.getByRole("heading", { level: 1, name: "Agent", exact: true })).toBeVisible()
}

test("agents are plugins with settings that reach the composer", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "pigcode-e2e-agents-"))
  const { app, page } = await openThread("agents", { PIGCODE_PROFILE_DIR: profileDir })
  try {
    await openAgents(page)
    const list = page.locator(".agents-list")
    const defaultCodex = list.locator(".agent-row").filter({
      has: page.getByRole("button", { name: "打开 Codex 的设置", exact: true }),
    })
    await expect(list.locator(".agent-row-name")).toContainText(["Claude Code", "Codex"])
    // 内置的两个 agent 画品牌标志。
    await expect(defaultCodex.locator(".agent-brand")).toHaveAttribute("data-brand", "openai")

    await page.getByRole("button", { name: "添加实例" }).click()
    const wizard = page.getByRole("dialog", { name: "添加实例" })
    const claude = wizard.getByRole("option", { name: /^Claude Code/ })
    const codex = wizard.getByRole("option", { name: /^Codex/ })
    await expect(claude.locator(".agent-brand")).toHaveAttribute("data-brand", "claude")
    await expect(codex.locator(".agent-brand")).toHaveAttribute("data-brand", "openai")
    await codex.click()
    await wizard.getByRole("button", { name: "下一步" }).click()
    await expect(wizard.locator(".wizard-picked .agent-brand")).toHaveAttribute(
      "data-brand",
      "openai",
    )
    const instanceName = wizard.getByRole("textbox", { name: "实例名称" })
    const instanceId = wizard.getByRole("textbox", { name: "实例 ID" })
    await expect(instanceName).toBeFocused()
    for (const input of [instanceName, instanceId]) {
      await expect(input).toHaveCSS("height", "36px")
      await expect(input).toHaveCSS("border-radius", "8px")
      await expect(input).toHaveCSS("padding-inline-start", "12px")
      await expect(input).toHaveCSS("font-size", "14px")
    }
    await instanceName.fill("公司 API")
    const invalidShadow = await instanceId.evaluate((input) => {
      const sample = document.createElement("span")
      sample.style.boxShadow = "inset 0 0 0 1px var(--bad)"
      input.after(sample)
      const shadow = getComputedStyle(sample).boxShadow
      sample.remove()
      return shadow
    })
    await instanceId.fill("2-invalid")
    await instanceId.hover()
    await expect(instanceId).toHaveAttribute("aria-invalid", "true")
    await expect(instanceId).toHaveCSS("box-shadow", invalidShadow)
    await expect(instanceId).toHaveCSS("height", "36px")
    await instanceId.fill("work_codex")
    await wizard.getByRole("button", { name: "下一步" }).click()
    const runtimeValues = {
      homePath: join(profileDir, "work-home"),
      launchArgs: "-c model_reasoning_summary=detailed",
    }
    const homeInput = wizard.getByRole("textbox", { name: "CODEX_HOME" })
    const launchArgsInput = wizard.getByRole("textbox", { name: "启动参数" })
    await expect(homeInput).toHaveCSS("height", "36px")
    await expect(launchArgsInput).toHaveCSS("height", "36px")
    await expect(wizard.getByRole("button", { name: "选择… CODEX_HOME" })).toHaveCSS(
      "height",
      "32px",
    )
    await homeInput.fill(runtimeValues.homePath)
    await launchArgsInput.fill(runtimeValues.launchArgs)
    await expect(wizard.getByRole("button", { name: "添加变量" })).toHaveCount(0)
    await expect(wizard.getByRole("textbox", { name: "模型 id，回车添加" })).toHaveCount(0)
    await wizard.getByRole("button", { name: "创建实例" }).click()
    await expect(wizard).toBeHidden()
    await expect(page.getByRole("button", { name: "打开 公司 API 的设置" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    const settingsPath = join(profileDir, "settings.json")
    const created = JSON.parse(readFileSync(settingsPath, "utf8")).agentInstances.work_codex
    expect(created).toMatchObject({ agentId: "codex", label: "公司 API" })
    expect(created.values).toEqual(runtimeValues)

    // 在自动展开的新实例里配置环境变量和自定义模型。
    const editor = page.locator(".agent-editor")
    await editor.getByRole("tab", { name: "运行" }).click()
    await expect(editor.getByRole("textbox", { name: "可执行文件" })).toHaveAttribute(
      "placeholder",
      "codex",
    )
    await expect(editor.getByRole("textbox", { name: "CODEX_HOME" })).toHaveValue(
      runtimeValues.homePath,
    )
    await expect(editor.getByRole("textbox", { name: "启动参数" })).toHaveValue(
      runtimeValues.launchArgs,
    )
    await editor.getByRole("tab", { name: "环境变量" }).click()
    await editor.getByRole("button", { name: "添加变量" }).click()
    const variableName = editor.getByRole("textbox", { name: "变量名 1" })
    await variableName.fill("1_BAD")
    await expect(variableName).toHaveAttribute("aria-invalid", "true")
    await expect(variableName).toHaveAccessibleDescription(/不能以数字开头/)
    await variableName.fill("OPENAI_BASE_URL")
    await expect(variableName).not.toHaveAttribute("aria-invalid", "true")
    await editor.getByRole("textbox", { name: "值 1" }).fill("http://127.0.0.1:9/v1")
    await editor.getByRole("tab", { name: /^模型/ }).click()
    const model = editor.getByRole("textbox", { name: "模型 id，回车添加" })
    await expect(model).toHaveCSS("height", "28px")
    await expect(editor.getByRole("button", { name: "添加", exact: true })).toHaveCSS(
      "height",
      "28px",
    )
    await model.fill("gpt-work-e2e")
    await model.press("Enter")
    await editor.getByRole("button", { name: "保存" }).click()
    await expect(editor.getByText("已保存，对之后新建的会话生效")).toBeVisible()
    await page.screenshot({ path: "test-results/agents-codex-settings.png" })

    const saved = JSON.parse(readFileSync(settingsPath, "utf8")).agentInstances.work_codex
    expect(saved.values).toEqual({
      ...runtimeValues,
      environment: [{ name: "OPENAI_BASE_URL", value: "http://127.0.0.1:9/v1" }],
      customModels: ["gpt-work-e2e"],
    })

    // 自定义模型出现在输入框的模型选择器里，标着「自定义」。
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    await page.getByRole("tab", { name: "公司 API" }).click()
    const models = page.getByRole("listbox", { name: "公司 API" })
    await expect(models).toContainText("gpt-work-e2e")
    await expect(models).toContainText("自定义")
    await page.keyboard.press("Escape")

    // 停用 Codex：插件卸下，输入框里不再有它；再启用回来。
    await openAgents(page)
    await page.getByRole("switch", { name: "启用 Codex" }).click()
    await expect(defaultCodex).toContainText("已停用")
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    await expect(page.getByRole("tab", { name: "Claude Code" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Codex" })).toHaveCount(0)
    await expect(page.getByRole("tab", { name: "公司 API" })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await openAgents(page)
    await page.getByRole("switch", { name: "启用 Codex" }).click()
    await expect(defaultCodex).not.toContainText("已停用")

    // 在插件页安装和卸载 echo agent，Agent 设置只提供实例配置。
    await expect(page.getByRole("button", { name: "安装 agent" })).toHaveCount(0)
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
    const echo = new URL("../../../examples/agent-echo", import.meta.url).pathname
    await installPlugin(page, echo)
    await page.getByRole("button", { name: "打开 Echo 的设置" }).click()
    const echoRow = list.locator(".agent-row").filter({ hasText: "Echo" })
    await expect(echoRow).toContainText("就绪")
    await page.screenshot({ path: "test-results/agents-list.png" })
    await page.getByRole("button", { name: "打开 Echo 的设置" }).click()
    await expect(page.getByRole("button", { name: "卸载", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
    await page.getByRole("button", { name: "插件管理", exact: true }).click()
    await page.getByRole("button", { name: "Echo 的更多操作" }).click()
    await page.getByRole("menuitem", { name: "卸载" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "确认卸载" }).click()
    await expect(page.locator('.market-tile[data-plugin="pigcode-agent-echo"]')).toHaveCount(0)
    await openAgents(page)
    await expect(echoRow).toHaveCount(0)

    // 恢复默认也要保存，并显示保存结果。
    await page.getByRole("button", { name: "打开 Codex 的设置" }).click()
    await editor.getByRole("tab", { name: "运行" }).click()
    await editor.getByRole("textbox", { name: "启动参数" }).fill(runtimeValues.launchArgs)
    await editor.getByRole("button", { name: "保存" }).click()
    await expect(editor.getByText("已保存，对之后新建的会话生效")).toBeVisible()
    await editor.getByRole("button", { name: "恢复默认" }).click()
    await editor.getByRole("button", { name: "保存" }).click()
    await expect(editor.getByText("已保存，对之后新建的会话生效")).toBeVisible()
  } finally {
    await app.close()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test("an agent can hold several instances, and threads bind to the one they used", async () => {
  const { app, page } = await openThread("instances")
  try {
    await openAgents(page)
    await page.getByRole("button", { name: "打开 Fake Agent 的设置" }).click()
    await page.getByRole("button", { name: "添加实例" }).click()
    const fakeAgent = page.getByRole("option", { name: /^Fake Agent/ })
    await expect(fakeAgent.locator(".entity-avatar")).toHaveText("FA")
    // 三步向导：Agent 已预选，填写名称并用默认配置创建。
    await page.getByRole("button", { name: "下一步" }).click()
    await page.getByRole("textbox", { name: "实例名称" }).fill("公司 API")
    await page.getByRole("button", { name: "下一步" }).click()
    const wizard = page.getByRole("dialog", { name: "添加实例" })
    await expect(wizard.getByText("这个 Agent 可以直接创建实例。")).toBeVisible()
    await wizard.getByRole("button", { name: "创建实例" }).click()
    await expect(wizard).toBeHidden()
    // 新建后自动展开新实例，并读取 Agent 返回的模型目录。
    await expect(page.getByRole("button", { name: "打开 公司 API 的设置" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    const editor = page.locator(".agent-editor")
    await editor.getByRole("tab", { name: /^模型/ }).click()
    const models = editor.getByRole("list", { name: "模型" })
    await expect(models).toContainText("Fake Sage")
    await expect(models).toContainText("Fake Swift")

    // 草稿的模型选择器按实例列出：选中新实例的模型再发消息。
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    await page.getByRole("tab", { name: "公司 API" }).click()
    await page.getByRole("option", { name: /Fake Sage/ }).click()
    // 选完模型弹层不关，按 Esc 收起再输入。
    await page.keyboard.press("Escape")
    await page.locator(".tiptap").click()
    await page.keyboard.type("hello instance")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toBeVisible()

    // 侧栏会话行按实例显示名字。
    const block = page.locator(".proj-block").filter({ hasText: "pigcode-e2e-instances" })
    await expect(block.locator(".sess").first()).toContainText("公司 API")

    // 还有会话在用这个实例时，设置页拒绝删除并说明原因。
    await openAgents(page)
    await page.getByRole("button", { name: "打开 公司 API 的设置" }).click()
    await page.getByRole("tab", { name: "实例" }).click()
    const instance = page.getByRole("tabpanel", { name: "实例" })
    await expect(instance.getByRole("textbox", { name: "实例名称" })).toHaveCSS("height", "32px")
    await expect(instance.getByRole("button", { name: "改名称" })).toHaveCSS("height", "32px")
    await page.getByRole("button", { name: "删除实例" }).click()
    await page.getByRole("button", { name: "确认删除" }).click()
    await expect(page.getByText(/先在那些会话里换用别的实例/)).toBeVisible()
  } finally {
    await app.close()
  }
})

test("projects, threads and agent settings survive a restart", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "pigcode-e2e-persist-"))
  const root = mkdtempSync(join(tmpdir(), "pigcode-e2e-persist-project-"))
  // 用真实的数据库文件，而不是 E2E 默认的内存库。
  const env = launchEnv({
    PIGCODE_PROFILE_DIR: profileDir,
    PIGCODE_DB_PATH: join(profileDir, "pigcode.db"),
  })
  try {
    const first = await electron.launch({ args: launchArgs(), env })
    const page = await first.firstWindow()
    await addProject(first, page, root)
    const projectName = root.split("/").at(-1) ?? ""
    await page.locator(".proj-block").filter({ hasText: projectName }).locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.locator(".tiptap").click()
    await page.keyboard.type("remember me")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toBeVisible()
    await openAgents(page)
    await page.getByRole("button", { name: "打开 Claude Code 的设置" }).click()
    await page.getByRole("tab", { name: "运行" }).click()
    await page.getByRole("textbox", { name: "启动参数" }).fill("--chrome")
    await page.getByRole("button", { name: "保存" }).click()
    await expect(page.getByText("已保存，对之后新建的会话生效")).toBeVisible()
    await first.close()

    const second = await electron.launch({ args: launchArgs(), env })
    const again = await second.firstWindow()
    const block = again.locator(".proj-block").filter({ hasText: projectName })
    await expect(block).toBeVisible()
    await expect(block.locator(".sess")).toHaveCount(1)
    await block.locator(".sess").first().click()
    await expect(again.locator(".msg-user").filter({ hasText: "remember me" })).toBeVisible()
    await openAgents(again)
    await again.getByRole("button", { name: "打开 Claude Code 的设置" }).click()
    await again.getByRole("tab", { name: "运行" }).click()
    await expect(again.getByRole("textbox", { name: "启动参数" })).toHaveValue("--chrome")
    await second.close()
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
