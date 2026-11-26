/** Agent 插件：内置 Claude Code 与 Codex、设置页的表单与保存、启停、安装与卸载第三方 agent、跨重启保留。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeAgyFixture } from "../../host/src/agents/fixtures/executable"
import { _electron as electron, expect, test, type Page } from "@playwright/test"
import { addProject, installPlugin, launchEnv, openThread, launchArgs } from "./projects"

/** 打开「设置 → Agent」。 */
async function openAgents(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "Agent", exact: true }).first().click()
  await expect(page.getByRole("heading", { level: 1, name: "Agent", exact: true })).toBeVisible()
}

test("signs in to built-in Antigravity from Agent settings", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "pigcode-e2e-agy-"))
  const binaryPath = writeAgyFixture(profileDir)
  writeFileSync(
    join(profileDir, "settings.json"),
    JSON.stringify({ "agents.antigravity": { binaryPath } }),
  )
  const { app, page } = await openThread("antigravity", { PIGCODE_PROFILE_DIR: profileDir })
  try {
    await openAgents(page)
    const open = page.getByRole("button", { name: "打开 Antigravity 的设置" })
    await open.click()
    const signIn = page.getByRole("button", { name: "登录 Google", exact: true })
    await expect(signIn).toBeEnabled()
    await signIn.click()
    await expect(page.getByRole("button", { name: "打开 Google 登录页" })).toBeEnabled()
    await open.click()
    await open.click()
    await page.getByLabel("验证码或网址").fill("work")
    await page.getByRole("button", { name: "连接", exact: true }).click()
    const signOut = page.getByRole("button", { name: "退出 Google 登录", exact: true })
    await expect(signOut).toBeVisible()
    await expect(page.getByRole("list", { name: "模型" })).toContainText("work model")
    await signOut.click()
    await expect(signIn).toBeEnabled()
  } finally {
    await app.close()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test("agents are plugins with settings that reach the composer", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "pigcode-e2e-agents-"))
  const { app, page } = await openThread("agents", { PIGCODE_PROFILE_DIR: profileDir })
  try {
    await openAgents(page)
    const list = page.locator(".agents-list")
    const defaultCodex = list.locator(".agent-item").filter({
      has: page.getByRole("button", { name: "打开 Codex 的设置", exact: true }),
    })
    await expect(list.locator(".agent-item-name")).toContainText([
      "Claude Code",
      "Codex",
      "Antigravity",
    ])
    // 内置的两个 agent 画品牌标志。
    await expect(defaultCodex.locator(".agent-brand")).toHaveAttribute("data-brand", "openai")

    await page.getByRole("button", { name: "添加 Agent" }).click()
    const wizard = page.getByRole("dialog", { name: "添加 Agent" })
    const claude = wizard.getByRole("option", { name: /^Claude Code/ })
    const codex = wizard.getByRole("option", { name: /^Codex/ })
    await expect(claude.locator(".agent-brand")).toHaveAttribute("data-brand", "claude")
    await expect(codex.locator(".agent-brand")).toHaveAttribute("data-brand", "openai")
    await codex.click()
    await wizard.getByRole("radio", { name: "用电脑上装好的 Codex" }).click()
    await expect(wizard.locator(".wizard-picked .agent-brand")).toHaveAttribute(
      "data-brand",
      "openai",
    )
    const instanceName = wizard.getByRole("textbox", { name: "名字" })
    const instanceId = wizard.getByRole("textbox", { name: "ID" })
    await expect(instanceName).toBeFocused()
    // 向导的设置行和设置页一样：输入框是 Cursor 默认的 28 高、圆角 8，靠右。
    for (const input of [instanceName, instanceId]) {
      await expect(input).toHaveCSS("height", "28px")
      await expect(input).toHaveCSS("border-radius", "8px")
      await expect(input).toHaveCSS("padding-inline-start", "8px")
      await expect(input).toHaveCSS("font-size", "13px")
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
    await expect(instanceId).toHaveCSS("height", "28px")
    await instanceId.fill("work_codex")
    const runtimeValues = {
      homePath: join(profileDir, "work-home"),
      launchArgs: "-c model_reasoning_summary=detailed",
    }
    await wizard.getByRole("button", { name: "高级设置" }).click()
    const homeInput = wizard.getByRole("textbox", { name: "配置文件夹" })
    mkdirSync(runtimeValues.homePath)
    const launchArgsInput = wizard.getByRole("textbox", { name: "启动参数" })
    await expect(homeInput).toHaveCSS("height", "28px")
    await expect(launchArgsInput).toHaveCSS("height", "28px")
    await expect(wizard.getByRole("button", { name: "选择… 配置文件夹" })).toHaveCSS(
      "height",
      "28px",
    )
    await homeInput.fill(runtimeValues.homePath)
    await launchArgsInput.fill(runtimeValues.launchArgs)
    await expect(wizard.getByRole("button", { name: "添加变量" })).toHaveCount(0)
    await expect(wizard.getByRole("textbox", { name: "输入模型 ID，回车添加" })).toHaveCount(0)
    await wizard.getByRole("button", { name: "创建" }).click()
    await expect(wizard).toBeHidden()
    await expect(page.getByRole("button", { name: "打开 公司 API 的设置" })).toHaveAttribute(
      "aria-current",
      "true",
    )
    const settingsPath = join(profileDir, "settings.json")
    const created = JSON.parse(readFileSync(settingsPath, "utf8")).agentInstances.work_codex
    expect(created).toMatchObject({ agentId: "codex", label: "公司 API" })
    expect(created.values).toEqual({ ...runtimeValues, setupMode: "existing" })

    // 新实例自动选中，在右边配置环境变量和自定义模型。
    const editor = page.locator(".agent-editor")
    await expect(editor.getByRole("textbox", { name: "程序位置" })).toHaveAttribute(
      "placeholder",
      "codex",
    )
    await expect(editor.getByRole("textbox", { name: "配置文件夹" })).toHaveValue(
      runtimeValues.homePath,
    )
    await expect(editor.getByRole("textbox", { name: "启动参数" })).toHaveValue(
      runtimeValues.launchArgs,
    )
    await editor.getByRole("button", { name: "添加变量" }).click()
    const variableName = editor.getByRole("textbox", { name: "变量名 1" })
    await variableName.fill("1_BAD")
    await expect(variableName).toHaveAttribute("aria-invalid", "true")
    await expect(variableName).toHaveAccessibleDescription(/不能用数字开头/)
    await variableName.fill("OPENAI_BASE_URL")
    await expect(variableName).not.toHaveAttribute("aria-invalid", "true")
    const secret = editor.getByLabel("值 1", { exact: true })
    await expect(secret).toHaveAttribute("type", "password")
    await secret.fill("http://127.0.0.1:9/v1")
    const model = editor.getByRole("textbox", { name: "输入模型 ID，回车添加" })
    await expect(model).toHaveCSS("height", "28px")
    await expect(editor.getByRole("button", { name: "添加", exact: true })).toHaveCSS(
      "height",
      "28px",
    )
    await model.fill("gpt-work-e2e")
    await model.press("Enter")
    await editor.getByRole("button", { name: "保存", exact: true }).click()
    await expect(editor.getByText("已保存", { exact: true })).toBeVisible()
    await page.screenshot({ path: "test-results/agents-codex-settings.png" })

    const persisted = readFileSync(settingsPath, "utf8")
    expect(persisted).not.toContain("http://127.0.0.1:9/v1")
    const saved = JSON.parse(persisted).agentInstances.work_codex
    expect(saved.values).toEqual({
      ...runtimeValues,
      setupMode: "existing",
      environment: [
        { name: "OPENAI_BASE_URL", value: { privateSlot: expect.any(String) }, sensitive: true },
      ],
      customModels: ["gpt-work-e2e"],
    })

    // 自定义模型出现在输入框的模型选择器里，标着「自定义」。
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 和模型/ }).click()
    await page.getByRole("tab", { name: "公司 API" }).click()
    const models = page.getByRole("listbox", { name: "公司 API" })
    await expect(models).toContainText("gpt-work-e2e")
    await expect(models).toContainText("自定义")
    await page.keyboard.press("Escape")

    // 默认 Codex 和自定义账号分别启停（开关在每一行上）。停用默认实例后，自定义实例仍出现在输入框里。
    await openAgents(page)
    await page.getByRole("switch", { name: "启用 Codex" }).click()
    await expect(defaultCodex).toContainText("已关闭")
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 和模型/ }).click()
    await expect(page.getByRole("tab", { name: "Claude Code" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Codex" })).toHaveCount(0)
    await expect(page.getByRole("tab", { name: "公司 API" })).toBeVisible()
    await page.keyboard.press("Escape")
    await openAgents(page)
    await page.getByRole("switch", { name: "启用 Codex" }).click()
    await expect(defaultCodex).not.toContainText("已关闭")

    // 在插件页安装和卸载 echo agent，Agent 设置只提供实例配置。
    await expect(page.getByRole("button", { name: "安装 agent" })).toHaveCount(0)
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
    const echo = new URL("../../../examples/agent-echo", import.meta.url).pathname
    await installPlugin(page, echo)
    await page.getByRole("button", { name: "打开 Echo 的设置" }).click()
    const echoRow = list.locator(".agent-item").filter({ hasText: "Echo" })
    await expect(echoRow).toContainText("能用")
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

    // 恢复默认也要保存，并显示保存结果；它在「其他」一组里。
    await page.getByRole("button", { name: "打开 Codex 的设置" }).click()
    await editor.getByRole("textbox", { name: "启动参数" }).fill(runtimeValues.launchArgs)
    await editor.getByRole("button", { name: "保存", exact: true }).click()
    await expect(editor.getByText("已保存", { exact: true })).toBeVisible()
    await editor.getByRole("button", { name: "还原" }).click()
    await editor.getByRole("button", { name: "保存", exact: true }).click()
    await expect(editor.getByText("已保存", { exact: true })).toBeVisible()
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
    await page.getByRole("button", { name: "添加 Agent" }).click()
    const fakeAgent = page.getByRole("option", { name: /^Fake Agent/ })
    await expect(fakeAgent.locator(".entity-avatar")).toHaveText("FA")
    await fakeAgent.click()
    await page.getByRole("textbox", { name: "名字" }).fill("公司 API")
    const wizard = page.getByRole("dialog", { name: "添加 Agent" })
    await expect(wizard.locator(".wizard-config")).toHaveCount(0)
    await wizard.getByRole("button", { name: "创建" }).click()
    await expect(wizard).toBeHidden()
    // 新建后自动选中新实例，并读取 Agent 返回的模型目录。
    await expect(page.getByRole("button", { name: "打开 公司 API 的设置" })).toHaveAttribute(
      "aria-current",
      "true",
    )
    const editor = page.locator(".agent-editor")
    const models = editor.getByRole("list", { name: "模型" })
    await expect(models).toContainText("Fake Sage")
    await expect(models).toContainText("Fake Swift")

    // 草稿的模型选择器按实例列出：选中新实例的模型再发消息。
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 和模型/ }).click()
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
    const instance = page.getByRole("region", { name: "公司 API" })
    await expect(instance.getByRole("textbox", { name: "名字" })).toHaveCSS("height", "28px")
    await instance.getByRole("button", { name: "删除", exact: true }).click()
    await instance.getByRole("button", { name: "确定删除" }).click()
    await expect(page.getByText(/先换成别的，再删除/)).toBeVisible()
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
    await page.getByRole("textbox", { name: "启动参数" }).fill("--chrome")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await expect(page.getByText("已保存", { exact: true })).toBeVisible()
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
    await expect(again.getByRole("textbox", { name: "启动参数" })).toHaveValue("--chrome")
    await second.close()
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test("Claude defaults persist without replacing an instance draft, and an override stays independent", async () => {
  const profile = mkdtempSync(join(tmpdir(), "pigcode-e2e-claude-defaults-"))
  const { app, page } = await openThread("claude-defaults", { PIGCODE_PROFILE_DIR: profile })
  const stored = () => JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"))
  try {
    await openAgents(page)
    await expect(page.getByText("高级设置", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "打开 Claude Code 的设置" }).click()
    const editor = page.locator(".agent-editor")
    const args = editor.getByRole("textbox", { name: "启动参数", exact: true })
    await args.fill("--verbose")
    const rule = editor.getByRole("combobox", { name: "空闲的会话", exact: true })
    await expect(rule).toContainText("跟 Claude 默认一样 · 回来时问我")
    // 所有 Claude 共用的默认是单独一行，选好就保存，不进草稿。
    const global = editor.getByRole("combobox", { name: "Claude 的默认", exact: true })
    const changeDefault = async (choice: string) => {
      await global.click()
      await page.getByRole("option", { name: choice, exact: true }).click()
      await expect(global).toHaveText(choice)
      await expect(page.getByRole("listbox")).toHaveCount(0)
    }
    await changeDefault("过期前自动压缩")
    await expect(rule).toContainText("跟 Claude 默认一样 · 过期前自动压缩")
    expect(stored()["claude.idleCompaction"]).toBe("beforeCacheExpires")
    expect(stored()["agents.claude"]?.launchArgs).toBeUndefined()
    await rule.click()
    await page.getByRole("option", { name: "不压缩", exact: true }).click()
    await expect(args).toHaveValue("--verbose")
    await editor.getByRole("button", { name: "保存", exact: true }).click()
    await expect(editor.getByText("已保存", { exact: true })).toBeVisible()
    await changeDefault("回来时问我")
    await expect(rule).toHaveText("不压缩")
    expect(stored()["agents.claude"]).toMatchObject({
      idleCompaction: "off",
      launchArgs: "--verbose",
    })
    await app.close()
    const restart = await electron.launch({
      args: launchArgs(),
      env: launchEnv({ PIGCODE_PROFILE_DIR: profile }),
    })
    try {
      const again = await restart.firstWindow()
      await openAgents(again)
      await again.getByRole("button", { name: "打开 Claude Code 的设置" }).click()
      const persistedRule = again.getByRole("combobox", { name: "空闲的会话", exact: true })
      await expect(persistedRule).toHaveText("不压缩")
      await persistedRule.click()
      await expect(
        again.getByRole("option", { name: "跟 Claude 默认一样 · 回来时问我" }),
      ).toBeVisible()
    } finally {
      await restart.close()
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
})
