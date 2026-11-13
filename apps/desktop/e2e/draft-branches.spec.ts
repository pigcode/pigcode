/** 验证草稿里的分支选择、worktree 首次发送和失败恢复。 */
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"
import { expectTerminalText } from "./terminal"

test("switches branches in the project and starts an isolated thread only when sent", async () => {
  const { app, page, root } = await openThread("draft-branches")
  try {
    const checkout = realpathSync(root)
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
    git("init", "-qb", "main")
    git("config", "user.name", "Pigcode E2E")
    git("config", "user.email", "e2e@example.com")
    git("add", ".")
    git("commit", "-qm", "init")
    git("switch", "-c", "base-for-worktree")
    writeFileSync(join(root, "README.md"), "# Worktree base\n")
    git("commit", "-qam", "base")
    const base = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/review", base)
    git("switch", "main")
    await page.reload()

    const rows = page.locator(".proj-block .sess")
    const editor = page.locator(".new-thread-view .tiptap")
    const branch = page.getByRole("button", { name: /^切换 Git 分支/ })
    await expect(branch).toHaveText("main")
    await branch.click()
    const search = page.getByRole("combobox", { name: "搜索分支" })
    await search.fill("base-for")
    await expect(page.getByRole("option", { name: "main", exact: true })).toHaveCount(0)
    await search.press("ArrowDown")
    await search.press("Enter")
    await expect(branch).toHaveText("base-for-worktree")
    expect(git("branch", "--show-current")).toBe("base-for-worktree")
    await branch.click()
    await page.getByRole("button", { name: "创建并切换分支" }).click()
    const create = page.getByRole("dialog", { name: "创建并切换分支" })
    await create.getByLabel("分支名").fill("feature/created-from-draft")
    await create.getByRole("button", { name: "创建并切换分支" }).click()
    await expect(create).toBeHidden()
    await expect(branch).toHaveText("feature/created-from-draft")
    expect(git("branch", "--show-current")).toBe("feature/created-from-draft")
    await branch.click()
    await page.getByRole("option", { name: "main", exact: true }).click()
    await expect(branch).toHaveText("main")
    git("switch", "--detach", base)
    await expect(branch).toHaveText(`游离 HEAD · ${base.slice(0, 7)}`)
    git("switch", "main")
    await expect(branch).toHaveText("main")

    const worktree = page.getByRole("switch", { name: "worktree" })
    await expect(worktree).not.toBeChecked()
    await worktree.click()
    await expect(worktree).toBeChecked()
    const picker = page.getByRole("button", { name: /^选择 worktree 起点/ })
    await picker.click()
    await expect(page.getByRole("option", { name: "当前 HEAD（main）" })).toBeVisible()
    await page.getByRole("option", { name: "origin/review" }).click()
    await expect(picker).toHaveText("origin/review")
    expect(git("branch", "--show-current")).toBe("main")
    expect(git("worktree", "list", "--porcelain")).not.toContain("-pigcode-")
    await expect(rows).toHaveCount(0)

    // 起点被外部删除时，Host 不留下空会话，原消息留在草稿里。
    git("update-ref", "-d", "refs/remotes/origin/review")
    await editor.fill("Check the worktree")
    await editor.press("Enter")
    await expect(page.getByRole("alert")).toContainText("创建 worktree 会话失败")
    await expect(editor).toHaveText("Check the worktree")
    await expect(rows).toHaveCount(0)
    expect(git("worktree", "list", "--porcelain")).not.toContain("-pigcode-")

    // 草稿里的 shell 先在原目录运行，建成独立会话后新 shell 跟随 worktree。
    writeFileSync(join(root, "README.md"), "# Local edits\n")
    await page.keyboard.press("Control+Backquote")
    const terminal = page.getByRole("region", { name: "底部终端" })
    await expect(terminal.getByRole("tab")).toHaveText(["pigcode-e2e-draft-branches"])
    await picker.click()
    await page.getByRole("option", { name: "base-for-worktree", exact: true }).click()
    await editor.press("Enter")
    await expect(page.locator(".msg-user")).toContainText("Check the worktree")
    await expect(rows).toHaveCount(1)
    await expect(page.locator(".turn").last()).toHaveAttribute("data-status", "completed")
    const worktrees = git("worktree", "list", "--porcelain")
    const created = worktrees
      .split("\n")
      .find((line) => line.startsWith(`worktree ${checkout}-pigcode-`))
      ?.slice("worktree ".length)
    expect(created).toBeTruthy()
    try {
      const top = page.locator(".panel-top")
      await expect(top.getByRole("button", { name: "选择打开方式" })).toBeVisible()
      expect(worktrees).toContain(`HEAD ${base}`)
      expect(git("branch", "--show-current")).toBe("main")
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Local edits\n")
      expect(readFileSync(join(created!, "README.md"), "utf8")).toBe("# Worktree base\n")
      await expect(terminal.getByRole("tab")).toHaveText([created!.split("/").at(-1)!])
      const xterm = terminal.locator(".terminal-pane:not([hidden]) .xterm")
      await xterm.click()
      await page.keyboard.type("printf 'BRANCH_DIR=%s\\n' \"$PWD\"")
      await page.keyboard.press("Enter")
      await expectTerminalText(xterm, `BRANCH_DIR=${created!}`)
    } finally {
      if (created) git("worktree", "remove", "--force", created)
    }
  } finally {
    await app.close()
  }
})
