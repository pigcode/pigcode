/** 真实 Codex 端到端：新建线程、发 OK、看到用户气泡与最终回答。 */
import { mkdirSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject } from "./projects"

test.skip(process.env.PIGCODE_REAL_CODEX !== "1", "set PIGCODE_REAL_CODEX=1")

/** 过滤 undefined，得到 Electron launch 要求的字符串环境变量表。 */
function launchEnv(): Record<string, string> {
  const entries = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  return { ...Object.fromEntries(entries), PIGCODE_REAL_CODEX: "1", PIGCODE_PROVIDER: "codex" }
}

test("real codex answers OK", async () => {
  // Codex app-server 以项目根目录作为 cwd，目录必须存在才能启动。
  mkdirSync("/tmp/pigcode-m2-e2e", { recursive: true })
  const app = await electron.launch({ args: ["."], env: launchEnv() })
  try {
    const page = await app.firstWindow()
    await addProject(app, page, "/tmp/pigcode-m2-e2e")
    await expect(page.getByText("pigcode-m2-e2e", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "新会话" }).first().click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("Reply with exactly OK")
    await page.keyboard.press("Enter")
    await expect(
      page.locator(".msg-user").filter({ hasText: "Reply with exactly OK" }),
    ).toBeVisible()
    await expect(page.getByText("OK", { exact: true })).toBeVisible({ timeout: 120_000 })
  } finally {
    await app.close()
  }
})
