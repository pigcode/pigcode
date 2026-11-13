/** 菜单读取插件声明，计划独立保存，选择实际进入 Host 的 session 参数。 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { codexExecutionModes } from "../../../packages/agent-codex/src/permissions"
import { claudeExecutionModes } from "../../../packages/agent-claude/src/permissions"
import { addProject, installPlugin, launchArgs, launchEnv } from "./projects"

test("uses four shared permissions, defaults to full access, and preserves the thread mode across agents", async () => {
  const work = mkdtempSync(join(tmpdir(), "pigcode-agent-modes-"))
  const plugin = join(work, "plugin")
  const project = join(work, "project")
  const records = join(work, "records.json")
  mkdirSync(plugin)
  mkdirSync(project)
  writeFileSync(join(project, "README.md"), "# Modes\n")
  writeFileSync(records, "[]")
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "pigcode-agent-mode-fixture",
      version: "1.0.0",
      type: "module",
      main: "./index.js",
      pigcode: {
        apiVersion: 1,
        kind: "agent",
        displayName: "Modes fixture",
        host: "./index.js",
        provides: ["agent:mode-codex", "agent:mode-claude"],
        permissions: ["fs:workspace"],
        contributes: { agent: { id: "mode-codex", settings: [] } },
      },
    }),
  )
  writeFileSync(
    join(plugin, "index.js"),
    `
    import { readFileSync, writeFileSync } from "node:fs";
    export const inject = ["agents"];
    export function apply(ctx) {
      const entries = ${JSON.stringify([
        { id: "mode-codex", displayName: "Codex 模式测试", executionModes: codexExecutionModes },
        { id: "mode-claude", displayName: "Claude 模式测试", executionModes: claudeExecutionModes },
      ])};
      for (const entry of entries) {
        const driver = {
          ...entry,
          features: { streaming: true, approvals: true, questions: false, plan: false, resume: false, fork: false,
            rollback: false, checkpoint: false, subagents: false, mcp: false, images: false, usage: false, modelCatalog: true, nativeSessionId: false },
          async detect() { return { installed: true, version: "1.0.0", authenticated: true }; },
          async listModels() { return [{ id: entry.id + "-model", displayName: entry.displayName + " Model", isDefault: true, efforts: [] }]; },
          async createSession(input) {
            return { ...input, id: entry.id + "-session", nativeSessionId: null, model: input.model ?? null,
              permissionMode: input.permissionMode, planMode: input.planMode === true };
          },
          async send(session, input, runtime) {
            const values = JSON.parse(readFileSync(${JSON.stringify(records)}, "utf8"));
            values.push({ agent: entry.id, permission: session.permissionMode, plan: session.planMode });
            writeFileSync(${JSON.stringify(records)}, JSON.stringify(values));
            runtime.emit({ type: "message.completed", text: "mode received" });
          },
          async interrupt() {}, async dispose() {},
        };
        ctx.agents.register(driver);
        ctx.effect(() => () => ctx.agents.unregister(driver.id));
      }
    }
  `,
  )
  const env = launchEnv({
    PIGCODE_PROFILE_DIR: join(work, "profile"),
    PIGCODE_DB_PATH: join(work, "profile", "pigcode.db"),
    PIGCODE_UPDATE_CHECK: "0",
    PIGCODE_CLAUDE_PATH: join(work, "no-claude"),
    PIGCODE_CODEX_PATH: join(work, "no-codex"),
  })
  const launch = () =>
    electron.launch({ args: launchArgs([`--user-data-dir=${join(work, "userData")}`]), env })
  let app = await launch()
  const readRecords = () => JSON.parse(readFileSync(records, "utf8"))
  try {
    let page = await app.firstWindow()
    await page.getByRole("button", { name: "插件", exact: true }).first().click()
    await installPlugin(page, plugin)
    await addProject(app, page, project)
    await page.getByRole("button", { name: "新会话", exact: true }).first().click()

    async function pickAgent(name: string) {
      await page.getByRole("button", { name: /^Agent 与模型:/ }).click()
      await page.getByRole("tab", { name, exact: true }).click()
      await page.getByRole("option", { name: new RegExp(name + " Model") }).click()
      await expect(page.getByRole("button", { name: /^Agent 与模型:/ })).toHaveAttribute(
        "aria-label",
        new RegExp(name),
      )
      await page.keyboard.press("Escape")
    }
    async function openOptions() {
      await page.getByRole("button", { name: /^Agent 与模型:/ }).click()
      return page.locator(".model-picker")
    }
    async function send(text: string) {
      await page.getByRole("textbox", { name: "给 agent 的消息" }).fill(text)
      await page.getByRole("button", { name: "发送", exact: true }).click()
      await expect(page.getByRole("button", { name: "中断", exact: true })).toHaveCount(0)
    }

    await pickAgent("Codex 模式测试")
    let picker = await openOptions()
    await picker.getByRole("button", { name: "权限: 完全访问", exact: true }).click()
    await expect(picker.getByRole("menuitemradio")).toHaveCount(4)
    const sharedLabels = await picker.getByRole("menuitemradio").allTextContents()
    await expect(picker.getByRole("menuitemradio", { name: /计划|只读/ })).toHaveCount(0)
    await picker.getByRole("menuitemradio", { name: /^自动审批/ }).click()
    await picker.getByRole("button", { name: "计划模式", exact: true }).click()
    await expect(picker.getByRole("button", { name: "计划模式", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    const planBox = await picker
      .getByRole("button", { name: "计划模式", exact: true })
      .boundingBox()
    const permissionButton = picker.getByRole("button", { name: "权限: 自动审批", exact: true })
    const permissionBox = await permissionButton.boundingBox()
    expect(Math.abs(planBox!.y - permissionBox!.y)).toBeLessThan(5)
    await permissionButton.click()
    await page.screenshot({ path: "test-results/agent-modes-codex.png", animations: "disabled" })
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await send("验证 Codex 计划")
    await expect
      .poll(readRecords)
      .toEqual([{ agent: "mode-codex", permission: "auto", plan: true }])

    picker = await openOptions()
    await picker.getByRole("button", { name: "计划模式", exact: true }).click()
    await expect(picker.getByRole("button", { name: "计划模式", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    await page.keyboard.press("Escape")
    await pickAgent("Claude 模式测试")
    picker = await openOptions()
    await picker.getByRole("button", { name: "权限: 自动审批", exact: true }).click()
    await expect(picker.getByRole("menuitemradio")).toHaveCount(4)
    expect(await picker.getByRole("menuitemradio").allTextContents()).toEqual(sharedLabels)
    await expect(picker.getByRole("menuitemradio", { name: /计划|只读/ })).toHaveCount(0)
    await picker.getByRole("menuitemradio", { name: /^接受编辑/ }).click()
    await picker.getByRole("button", { name: "计划模式", exact: true }).click()
    await picker.getByRole("button", { name: "权限: 接受编辑", exact: true }).click()
    await page.screenshot({ path: "test-results/agent-modes-claude.png", animations: "disabled" })
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.screenshot({ path: "test-results/agent-modes-dark.png", animations: "disabled" })
    await page.emulateMedia({ colorScheme: "light" })
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await send("验证 Claude 计划")
    await expect.poll(readRecords).toHaveLength(2)
    expect(readRecords()[1]).toEqual({
      agent: "mode-claude",
      permission: "auto-accept-edits",
      plan: true,
    })

    await pickAgent("Codex 模式测试")
    picker = await openOptions()
    await expect(picker.getByRole("button", { name: "权限: 接受编辑", exact: true })).toBeVisible()
    await expect(picker.getByRole("button", { name: "计划模式", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "新会话", exact: true }).first().click()
    picker = await openOptions()
    await expect(picker.getByRole("button", { name: "权限: 完全访问", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.locator(".sess").filter({ hasText: "验证 Codex 计划" }).click()
    picker = await openOptions()
    await expect(picker.getByRole("button", { name: "权限: 接受编辑", exact: true })).toBeVisible()
    await expect(picker.getByRole("button", { name: "计划模式", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  } finally {
    await app.close()
    rmSync(work, { recursive: true, force: true })
  }
})
