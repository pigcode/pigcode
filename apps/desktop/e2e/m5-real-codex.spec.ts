/** M5 真实 Codex 端到端：两个线程并行运行，分别得到 OK-1 与 OK-2。 */
import { mkdirSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject } from "./projects"

test.skip(process.env.PIGCODE_REAL_CODEX !== "1", "set PIGCODE_REAL_CODEX=1")

/** 过滤 undefined；强制使用 Codex 与 6.1sol 模型。 */
function launchEnv(): Record<string, string> {
  const entries = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  return {
    ...Object.fromEntries(entries),
    PIGCODE_REAL_CODEX: "1",
    PIGCODE_AGENT: "codex",
    PIGCODE_CODEX_MODEL: process.env.PIGCODE_CODEX_MODEL ?? "gpt-6.1-sol",
  }
}

test("runs two real codex threads from the sidebar", async () => {
  // Codex app-server 以项目根目录作为 cwd，目录必须存在才能启动。
  const projectRoot = "/tmp/pigcode-m5-real-e2e"
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({ args: ["."], env: launchEnv() })
  try {
    const page = await app.firstWindow()
    await addProject(app, page, projectRoot)
    const project = page.locator(".proj-block").filter({ hasText: "pigcode-m5-real-e2e" })
    await expect(project).toBeVisible()

    const row = (title: string) => project.locator(".sess").filter({ hasText: title })
    // 真实模型同时跑两个 turn 会触发模型服务的容量限制；E2E 逐线程验证 UI 链路，
    // 两个真实 run 的并行覆盖由 multi-session.real.test.ts 负责。
    await project.locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("Reply with exactly OK-1")
    await page.keyboard.press("Enter")
    await expect(row("OK-1")).toHaveAttribute("data-status", "completed", { timeout: 120_000 })

    await project.locator(".proj-add").click()
    await expect(project.locator(".sess")).toHaveCount(2)
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("Reply with exactly OK-2")
    await page.keyboard.press("Enter")
    await expect(row("OK-2")).toHaveAttribute("data-status", "completed", { timeout: 120_000 })

    // 从侧栏切回第一个线程，确认两个线程各自保留自己的结果。
    await row("OK-1").click()
    await expect(page.locator(".msg-ai").filter({ hasText: "OK-1" })).toBeVisible()
    await row("OK-2").click()
    await expect(page.locator(".msg-ai").filter({ hasText: "OK-2" })).toBeVisible()
  } finally {
    await app.close()
  }
})
