/** Agent 插件：内置 Claude Code 与 Codex、设置页的表单与保存、启停、安装与卸载第三方 agent、跨重启保留。 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test, type Page } from "@playwright/test"
import { addProject, launchEnv, openThread } from "./projects"

/** 打开「设置 → Agent」。 */
async function openAgents(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "Agent", exact: true }).first().click()
  await expect(page.getByRole("heading", { level: 1, name: "Agent", exact: true })).toBeVisible()
}

test("agents are plugins with settings that reach the composer", async () => {
  const { app, page } = await openThread("agents")
  try {
    await openAgents(page)
    const list = page.locator(".ext-list")
    await expect(list.locator(".ext-row-title")).toContainText(["Claude Code", "Codex"])
    await expect(list.locator(".ext-row").filter({ hasText: "Codex" })).toContainText("内置")

    // 展开 Codex：manifest 声明的字段都在；改设置并保存。
    await page.getByRole("button", { name: "展开 Codex 的设置" }).click()
    const editor = page.locator(".agent-editor")
    await expect(editor.getByRole("textbox", { name: "可执行文件" })).toHaveAttribute(
      "placeholder",
      "codex",
    )
    await expect(editor.getByRole("textbox", { name: "CODEX_HOME" })).toBeVisible()
    await editor
      .getByRole("textbox", { name: "启动参数" })
      .fill("-c model_reasoning_summary=detailed")
    await editor.getByRole("button", { name: "添加变量" }).click()
    await editor.getByRole("textbox", { name: "变量名 1" }).fill("OPENAI_BASE_URL")
    await editor.getByRole("textbox", { name: "值 1" }).fill("http://127.0.0.1:9/v1")
    const model = editor.getByRole("textbox", { name: "模型 id，例如 claude-sonnet-5" })
    await model.fill("gpt-pigcode-e2e")
    await model.press("Enter")
    await editor.getByRole("button", { name: "保存" }).click()
    await expect(editor.getByText("已保存，对之后新建的会话生效")).toBeVisible()
    await page.screenshot({ path: "test-results/agents-codex-settings.png" })

    const settings = JSON.parse(
      readFileSync(join(process.env.PIGCODE_PROFILE_DIR ?? "", "settings.json"), "utf8"),
    ) as Record<string, unknown>
    expect(settings["agents.codex"]).toEqual({
      launchArgs: "-c model_reasoning_summary=detailed",
      environment: [{ name: "OPENAI_BASE_URL", value: "http://127.0.0.1:9/v1" }],
      customModels: ["gpt-pigcode-e2e"],
    })

    // 自定义模型出现在输入框的模型选择器里，标着「自定义」。
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    await page.getByRole("tab", { name: "Codex" }).click()
    await expect(page.getByRole("listbox", { name: "Codex" })).toContainText("gpt-pigcode-e2e")
    await expect(page.getByRole("listbox", { name: "Codex" })).toContainText("自定义")
    await page.keyboard.press("Escape")

    // 停用 Codex：插件卸下，输入框里不再有它；再启用回来。
    await openAgents(page)
    await page.getByRole("switch", { name: "启用 Codex" }).click()
    await expect(list.locator(".ext-row").filter({ hasText: "Codex" })).toContainText("已停用")
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    await expect(page.getByRole("tab", { name: "Claude Code" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Codex" })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await openAgents(page)
    await page.getByRole("switch", { name: "启用 Codex" }).click()
    await expect(list.locator(".ext-row").filter({ hasText: "Codex" })).not.toContainText("已停用")

    // 从对话框安装 echo agent，再卸载。
    await page.getByRole("button", { name: "安装 agent" }).click()
    const echo = new URL("../../../examples/agent-echo", import.meta.url).pathname
    await page.getByRole("textbox", { name: "npm 包或插件目录" }).fill(echo)
    await page.getByRole("dialog").getByRole("button", { name: "安装", exact: true }).click()
    const echoRow = list.locator(".ext-row").filter({ hasText: "Echo" })
    await expect(echoRow).toContainText("就绪")
    await expect(echoRow).not.toContainText("内置")
    await page.screenshot({ path: "test-results/agents-list.png" })
    await page.getByRole("button", { name: "展开 Echo 的设置" }).click()
    await page.getByRole("button", { name: "卸载", exact: true }).click()
    await page.getByRole("button", { name: "确认卸载" }).click()
    await expect(echoRow).toHaveCount(0)

    // 清理：本测试改过的设置不能影响后面的用例。
    await page.getByRole("button", { name: "展开 Codex 的设置" }).click()
    await page.getByRole("button", { name: "恢复默认" }).click()
    await page.getByRole("button", { name: "保存" }).click()
    await expect(page.getByText("已保存，对之后新建的会话生效")).toBeVisible()
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
    const first = await electron.launch({ args: ["."], env })
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
    await page.getByRole("button", { name: "展开 Claude Code 的设置" }).click()
    await page.getByRole("textbox", { name: "启动参数" }).fill("--chrome")
    await page.getByRole("button", { name: "保存" }).click()
    await expect(page.getByText("已保存，对之后新建的会话生效")).toBeVisible()
    await first.close()

    const second = await electron.launch({ args: ["."], env })
    const again = await second.firstWindow()
    const block = again.locator(".proj-block").filter({ hasText: projectName })
    await expect(block).toBeVisible()
    await expect(block.locator(".sess")).toHaveCount(1)
    await block.locator(".sess").first().click()
    await expect(again.locator(".msg-user").filter({ hasText: "remember me" })).toBeVisible()
    await openAgents(again)
    await again.getByRole("button", { name: "展开 Claude Code 的设置" }).click()
    await expect(again.getByRole("textbox", { name: "启动参数" })).toHaveValue("--chrome")
    await second.close()
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
