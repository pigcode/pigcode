/**
 * 新会话草稿里的底部终端与右侧面板（参照 ZCode）：打开它们不建会话，都挂在草稿的项目上（项目根目录）；
 * 第一次发送建好会话后原样交给这个会话：shell 还是那个 shell，标签、改了一半的文件都还在。
 * 检查点属于会话的 run，草稿里不能打开。
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"
import { expectTerminalText, terminalText } from "./terminal"

test("the bottom terminal opens in a draft without creating a thread", async () => {
  const { app, page } = await openThread("draft-terminal", { TERM: "dumb" })
  try {
    const project = page.locator(".proj-block").filter({ hasText: "pigcode-e2e-draft-terminal" })
    const rows = project.locator(".sess")
    await expect(page.locator(".new-thread-view")).toBeVisible()
    await expect(rows).toHaveCount(0)

    // ⌃` 在草稿里直接打开终端：标签以项目目录命名，shell 就在项目根目录。
    await page.keyboard.press("Control+Backquote")
    const drawer = page.getByRole("region", { name: "底部终端" })
    const xterm = drawer.locator(".terminal-pane:not([hidden]) .xterm")
    await expect(xterm).toBeVisible()
    await expect(drawer.getByRole("tab")).toHaveText(["pigcode-e2e-draft-terminal"])
    await xterm.click()
    await page.keyboard.type("printf 'PIGCODE_TERM=%s\\n' \"$TERM\"")
    await page.keyboard.press("Enter")
    await expectTerminalText(xterm, "PIGCODE_TERM=xterm-256color")
    // 用算术展开：输出里出现的结果不会是命令回显本身。
    await page.keyboard.type("export DRAFT_MARK=$((40+2)); echo IN_$(basename $PWD)_$DRAFT_MARK")
    await page.keyboard.press("Enter")
    await expectTerminalText(xterm, "IN_pigcode-e2e-draft-terminal_42")

    // 还是草稿：侧栏没有新行，右上角的终端按钮是按下的。
    await expect(page.locator(".new-thread-view")).toBeVisible()
    await expect(rows).toHaveCount(0)
    await expect(
      page.locator(".panel-top").getByRole("button", { name: "切换底部终端" }),
    ).toHaveAttribute("aria-pressed", "true")

    // 第一次发送才建会话；终端留在原地，还是同一个 shell（刚才设的变量还在）。
    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello" })).toBeVisible()
    await expect(rows).toHaveCount(1)
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("tab")).toHaveCount(1)
    await expectTerminalText(xterm, "IN_pigcode-e2e-draft-terminal_42")
    await xterm.click()
    await page.keyboard.type("echo STILL_$DRAFT_MARK")
    await page.keyboard.press("Enter")
    await expectTerminalText(xterm, "STILL_42")

    // 再进一个新草稿：各草稿各记开关，新草稿里终端是收起的；打开后是新的 shell，不带上一个会话的输出。
    await project.locator(".proj-add").click()
    await expect(page.locator(".new-thread-view")).toBeVisible()
    await expect(drawer).toBeHidden()
    await page.keyboard.press("Control+Backquote")
    await expect(xterm).toBeVisible()
    await expect.poll(() => terminalText(xterm), { timeout: 15_000 }).not.toBe("")
    expect(await terminalText(xterm)).not.toContain("STILL_42")
    await expect(rows).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test("the right panel opens in a draft without creating a thread", async () => {
  const { app, page, root } = await openThread("draft-panel")
  try {
    // 做成 git 仓库，再在磁盘上改一个文件：草稿里的 Diff 看的是项目根目录的未提交改动。
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root })
    git("init", "-q")
    git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "add", ".")
    git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init")
    writeFileSync(join(root, "README.md"), "# Demo\nDRAFT_DIFF_LINE\n")

    const project = page.locator(".proj-block").filter({ hasText: "pigcode-e2e-draft-panel" })
    const rows = project.locator(".sess")
    await expect(rows).toHaveCount(0)

    await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
    const launcher = page.getByLabel("打开一个面板")
    await expect(launcher).toBeVisible()
    // 检查点要等第一次运行才有：置灰并说明原因。
    const checkpoint = launcher.getByRole("button", { name: /检查点/ })
    await expect(checkpoint).toBeDisabled()
    await expect(checkpoint).toHaveAttribute("title", "发出第一条消息后才有检查点")

    // 文件树：项目根目录；worktree 属于会话，草稿里没有选择器。
    await launcher.getByRole("button", { name: /^文件/ }).click()
    const pane = page.locator(".right-panel-body .surface-pane:not([hidden])")
    const readme = pane.locator('[role="treeitem"]').filter({ hasText: /^README\.md/ })
    await expect(readme).toBeVisible()
    await expect(page.locator(".workbench-worktree-compact")).toHaveCount(0)
    await readme.click()
    await page.getByRole("button", { name: "源码", exact: true }).click()
    const editor = page.getByRole("textbox", { name: "文件内容 README.md" })
    await expect(editor).toContainText("DRAFT_DIFF_LINE")
    // 改了不保存：建好会话后这份未保存的修改还在。
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("UNSAVED_EDIT")
    await expect(page.locator(".surface-tab-dirty")).toBeVisible()

    const tabs = page.locator(".right-panel").getByRole("tab")
    const addPanel = async (name: RegExp) => {
      await page.getByRole("button", { name: "添加面板" }).click()
      await page.getByRole("menuitem", { name }).click()
    }
    await addPanel(/^Diff/)
    await expect(pane.locator(".workbench-diff")).toContainText("DRAFT_DIFF_LINE")
    await addPanel(/^终端/)
    const xterm = pane.locator(".xterm")
    await expect(xterm).toBeVisible()
    await xterm.click()
    await page.keyboard.type("export PANEL_MARK=$((6*7)); echo PANEL_$PANEL_MARK")
    await page.keyboard.press("Enter")
    await expectTerminalText(xterm, "PANEL_42")
    await expect(tabs).toHaveText(["README.md", "Diff", "终端 1"])
    await expect(rows).toHaveCount(0)

    // 第一次发送才建会话；右栏原样留下，同一个 shell、同一份未保存的修改。
    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello" })).toBeVisible()
    await expect(rows).toHaveCount(1)
    await expect(tabs).toHaveText(["README.md", "Diff", "终端 1"])
    await expect(page.locator(".surface-tab-dirty")).toBeVisible()
    await page.getByRole("tab", { name: "终端 1" }).click()
    await xterm.click()
    await page.keyboard.type("echo AGAIN_$PANEL_MARK")
    await page.keyboard.press("Enter")
    await expectTerminalText(xterm, "AGAIN_42")
    // 有了会话，检查点可以打开了。
    await page.getByRole("button", { name: "添加面板" }).click()
    await expect(page.getByRole("menuitem", { name: /检查点/ })).toBeEnabled()
    await page.keyboard.press("Escape")
    // 保存掉修改：保存的是项目里的文件；有未保存的修改时退出会弹确认框，把关应用卡住。
    await page.getByRole("tab", { name: "README.md" }).click()
    await editor.click()
    await page.keyboard.press("ControlOrMeta+s")
    await expect(page.locator(".surface-tab-dirty")).toHaveCount(0)
    await expect.poll(() => readFileSync(join(root, "README.md"), "utf8")).toContain("UNSAVED_EDIT")
  } finally {
    await app.close()
  }
})
