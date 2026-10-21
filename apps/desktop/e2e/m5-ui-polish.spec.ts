/** M5 UI 交互验收：自动标题、命令面板、快捷键与工作台。 */
import { mkdirSync, rmSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"

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
    args: ["."],
    env: { ...launchEnv(), PIGCODE_PROVIDER: "fake" },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole("button", { name: "添加项目" }).first().click()
    await page.getByLabel("项目路径").fill(projectRoot)
    await page.getByRole("button", { name: "添加", exact: true }).click()
    const project = page.locator(".proj-block").filter({ hasText: "pigcode-ui-polish" })
    await project.locator(".proj-add").click()

    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("检查登录流程")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "检查登录流程" })).toBeVisible()

    // 第一条消息后自动命名线程，tab 和侧栏同步显示。
    await expect(page.locator(".thread-tab .tab-title")).toHaveText("检查登录流程")
    await expect(page.locator(".sess-title").first()).toHaveText("检查登录流程")

    // ⌘K 打开命令面板；过滤后回车执行“显示或隐藏工作台”。
    await page.keyboard.press("Meta+k")
    await expect(page.locator(".palette")).toBeVisible()
    await page.locator(".palette input").fill("工作台")
    await page.keyboard.press("Enter")
    await expect(page.locator(".right-panel")).toBeVisible()

    // ⌘J 再次关闭工作台；⌘B 收起侧栏。
    await page.keyboard.press("Meta+j")
    await expect(page.locator(".right-panel")).toHaveCount(0)
    await page.keyboard.press("Meta+b")
    await expect(page.locator(".app")).toHaveClass(/is-collapsed/)
  } finally {
    await app.close()
  }
})
