/** M5 UI 交互验收：自动标题、命令面板、快捷键与右侧面板。 */
import { mkdirSync, rmSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject, launchArgs } from "./projects"

/** 过滤 undefined，满足 Playwright env 的 string 值约束。 */
function launchEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

test("polished shell: auto title, command palette and shortcuts", async () => {
  const projectRoot = "/tmp/pigcode-ui-polish"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({
    args: launchArgs(),
    env: { ...launchEnv(), PIGCODE_AGENT: "fake" },
  })
  try {
    const page = await app.firstWindow()
    await addProject(app, page, projectRoot)
    const project = page.locator(".proj-block").filter({ hasText: "pigcode-ui-polish" })
    await project.locator(".proj-add").click()

    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("检查登录流程")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "检查登录流程" })).toBeVisible()

    // 第一条消息后自动命名线程，侧栏与线程头同步显示；线程头的标签栏只有主会话一个标签。
    await expect(page.locator(".sess-title").first()).toHaveText("检查登录流程")
    await expect(page.locator(".panel-top .title-text")).toHaveText("检查登录流程")
    await expect(page.locator(".panel-top").getByRole("tab")).toHaveText(["检查登录流程"])

    // ⌘K 打开命令面板；过滤后回车执行“显示或隐藏右侧面板”。
    await page.keyboard.press("Meta+k")
    await expect(page.locator(".palette")).toBeVisible()
    await page.locator(".palette input").fill("右侧面板")
    await page.keyboard.press("Enter")
    await expect(page.locator(".right-panel")).toBeVisible()
    await expect(page.getByLabel("打开一个面板")).toBeVisible()

    // ⌘J 再次收起右侧面板（只隐藏不卸载）；⌘B 收起侧栏。
    await page.keyboard.press("Meta+j")
    await expect(page.locator(".right-panel")).toBeHidden()
    await page.keyboard.press("Meta+b")
    await expect(page.locator(".app")).toHaveClass(/is-collapsed/)
  } finally {
    await app.close()
  }
})
