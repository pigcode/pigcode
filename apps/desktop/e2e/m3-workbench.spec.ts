/** M3 验收：文件树、终端、checkpoint、diff、恢复。 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
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

test("workbench files, terminal, checkpoint, and diff", async () => {
  // 每次从干净仓库开始，避免上次失败留下的历史让 init/commit 结果不确定。
  const root = "/tmp/pigcode-m3-e2e"
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: root })
  writeFileSync(`${root}/a.txt`, "one\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root })

  const app = await electron.launch({
    args: launchArgs(),
    env: { ...launchEnv(), PIGCODE_AGENT: "fake" },
  })
  const page = await app.firstWindow()
  await addProject(app, page, root)
  await expect(page.getByText("pigcode-m3-e2e", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "新会话" }).first().click()

  // 打开右侧面板，从空面板启动器打开终端并跑一个命令。
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
  await page.getByLabel("打开一个面板").getByRole("button", { name: /终端/ }).click()
  await expect(page.getByRole("tab", { name: "终端 1" })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".xterm")).toBeVisible()
  await page.locator(".xterm").click()
  await page.keyboard.type("echo READY")
  await page.keyboard.press("Enter")
  await expect(page.locator(".xterm")).toContainText("READY")

  // 手动 checkpoint，修改文件后 diff/restore；终端标签切走后保持同一个 shell。
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: /检查点/ }).click()
  await page.getByRole("button", { name: "创建检查点" }).click()
  // 等快照真正建好再改文件；否则机器忙的时候，快照可能拍到下面写进去的内容。
  await expect(page.getByRole("button", { name: "恢复" }).first()).toBeVisible()
  await page.getByRole("tab", { name: "终端 1" }).click()
  await expect(page.locator(".xterm")).toContainText("READY")
  await page.locator(".xterm").click()
  // WROTE 用于确认 shell 已经真正改写了 a.txt，避免 restore 变成空操作。命令里拆开写：
  // 终端会回显输入的命令，写成一个词的话，命令还没执行断言就通过了，文件会在恢复之后才被改写。
  await page.keyboard.type("echo two > a.txt && echo WR''OTE")
  await page.keyboard.press("Enter")
  await expect(page.locator(".xterm")).toContainText("WROTE")

  // 改完再建一个快照：Diff 默认拿最新的快照和基准（HEAD）比，这样才看得到改动。
  await page.getByRole("tab", { name: "检查点" }).click()
  await page.getByRole("button", { name: "创建检查点" }).click()
  await expect(page.getByRole("button", { name: "恢复" })).toHaveCount(2)

  // 从界面看 diff：右栏的 Diff 显示快照相对基准的改动。
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: /Diff/ }).click()
  const diff = page.locator(".diff-view")
  await expect(diff.locator(".diff-file").filter({ hasText: "a.txt" })).toBeVisible()
  await expect(diff.locator(".diff-line-remove").first()).toContainText("one")
  await expect(diff.locator(".diff-line-add").first()).toContainText("two")

  await page.getByRole("tab", { name: "检查点" }).click()
  // 列表按时间从早到晚，第一个是改动前的快照。
  await page.getByRole("button", { name: "恢复" }).first().click()
  await page.getByRole("button", { name: "确认恢复" }).click()
  // 确认按钮消失代表 restore RPC 已完成，再读文件避免竞态。
  await expect(page.getByRole("button", { name: "确认恢复" })).toBeHidden()

  // 恢复后从文件树打开 a.txt，确认工作区回到 checkpoint 的内容；文件树标签换成文件标签。
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: /文件/ }).click()
  await expect(page.locator(".right-panel").getByRole("tab")).toHaveText([
    "终端 1",
    "检查点",
    "Diff",
    "文件",
  ])
  await page.getByRole("treeitem", { name: "a.txt" }).click()
  await expect(page.locator(".right-panel").getByRole("tab")).toHaveText([
    "终端 1",
    "检查点",
    "Diff",
    "a.txt",
  ])
  await expect(page.getByRole("textbox", { name: "文件内容 a.txt" })).toHaveValue("one\n")
  await app.close()
})
