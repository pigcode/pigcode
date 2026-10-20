/** M3 验收：文件树、终端、checkpoint、diff、恢复。 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"

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
    args: ["."],
    env: { ...launchEnv(), PIGCODE_PROVIDER: "fake" },
  })
  const page = await app.firstWindow()
  await page.getByRole("button", { name: "添加项目" }).first().click()
  await page.getByLabel("项目路径").fill(root)
  await page.getByRole("button", { name: "添加", exact: true }).click()
  await expect(page.getByText("pigcode-m3-e2e", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "新会话" }).first().click()

  // 打开右栏终端，跑一个命令。
  await page.getByRole("button", { name: "工作台" }).click()
  await page.getByRole("tab", { name: "终端" }).click()
  await expect(page.locator(".xterm")).toBeVisible()
  await page.locator(".xterm").click()
  await page.keyboard.type("echo READY")
  await page.keyboard.press("Enter")
  await expect(page.locator(".xterm")).toContainText("READY")

  // 手动 checkpoint，修改文件后 diff/restore。
  await page.getByRole("tab", { name: "检查点" }).click()
  await page.getByRole("button", { name: "创建检查点" }).click()
  await page.getByRole("tab", { name: "终端" }).click()
  await page.locator(".xterm").click()
  // WROTE 用于确认 shell 已经真正改写了 a.txt，避免 restore 变成空操作。
  await page.keyboard.type("echo two > a.txt && echo WROTE")
  await page.keyboard.press("Enter")
  await expect(page.locator(".xterm")).toContainText("WROTE")
  await page.getByRole("tab", { name: "检查点" }).click()
  await page.getByRole("button", { name: "恢复" }).first().click()
  await page.getByRole("button", { name: "确认恢复" }).click()
  // 确认按钮消失代表 restore RPC 已完成，再读文件避免竞态。
  await expect(page.getByRole("button", { name: "确认恢复" })).toBeHidden()

  // 恢复后从 Files tab 读取 a.txt，确认工作区回到 checkpoint 的内容。
  await page.getByRole("tab", { name: "文件" }).click()
  await page.getByRole("button", { name: "a.txt", exact: true }).click()
  await expect(page.getByRole("region", { name: "文件预览 a.txt" })).toContainText("one")
  await app.close()
})
