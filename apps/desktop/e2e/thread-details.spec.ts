/**
 * 会话详情：会话建好以后，草稿顶栏的「打开」挪进线程头按钮开关的详情卡，卡片里还有当前分支、
 * 还有几个文件没提交（点了在右侧面板打开 Diff）和 agent 列的待办。
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openThread, openThreadDetails } from "./projects"

test("thread details show the workspace, the branch and uncommitted changes", async () => {
  const { app, page, root } = await openThread("thread-details")
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" })
    git("init", "-qb", "main")
    git("config", "user.name", "Pigcode E2E")
    git("config", "user.email", "e2e@example.com")
    git("add", ".")
    git("commit", "-qm", "init")
    writeFileSync(join(root, "README.md"), "# Changed\n")
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { __opened?: string[] }).__opened = opened
      shell.openPath = async (path: string) => {
        opened.push(path)
        return ""
      }
    })
    const opened = () => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.locator(".turn").last()).toHaveAttribute("data-status", "completed")
    await expect(page.locator(".panel-top .open-in-split")).toHaveCount(0)

    let details = await openThreadDetails(page)
    await expect(details.getByRole("region", { name: "工作区" })).toContainText(
      "pigcode-e2e-thread-details",
    )
    const versionControl = details.getByRole("region", { name: "版本控制" })
    await expect(versionControl).toContainText("main")
    await expect(versionControl).toContainText("1 个文件未提交")

    // 列表第一项总是文件管理器；选中后它成为这一行左半边的默认应用。
    await details.getByRole("button", { name: "选打开方式" }).click()
    await page.locator(".open-in-menu .open-in-item").first().click()
    await expect.poll(opened).toEqual([root])
    details = await openThreadDetails(page)
    await details.locator(".details-split .details-row").click()
    await expect.poll(opened).toEqual([root, root])

    details = await openThreadDetails(page)
    await details.getByRole("button", { name: /^改动/ }).click()
    await expect(page.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true")
  } finally {
    await app.close()
  }
})

test("the agent's to-do list moves into thread details", async () => {
  const { app, page } = await openThread("thread-details-todos")
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type("showcase")
    await page.keyboard.press("Enter")
    await expect(page.locator(".turn").last()).toHaveAttribute("data-status", "completed", {
      timeout: 60_000,
    })
    const details = await openThreadDetails(page)
    const todos = details.getByRole("region", { name: "待办" })
    await expect(todos.locator(".details-todo")).toHaveCount(4)
    await expect(todos.locator(".details-todo[data-status='completed']")).toHaveCount(2)
    await expect(todos).toContainText("2/4")
  } finally {
    await app.close()
  }
})
