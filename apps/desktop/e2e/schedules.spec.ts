/** 从没有会话的项目创建任务，两次运行分别建会话，保存和恢复 Composer 的引用。 */
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { launchArgs, launchEnv } from "./projects"

test("scheduled tasks save the Composer input and create a separate thread on each run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-schedule-e2e-"))
  const project = join(root, "schedule-project")
  await mkdir(project)
  await writeFile(join(project, "README.md"), "# Scheduled project")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project })
  git("init", "-qb", "main")
  git("add", "README.md")
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "init",
    "--no-gpg-sign",
  )
  const worktrees = async () =>
    (await readdir(root)).filter((name) => name.startsWith("schedule-project-pigcode-"))
  const app = await electron.launch({ args: launchArgs(), env: launchEnv({}) })
  try {
    const page = await app.firstWindow()
    const sidebar = page.locator(".sidebar")
    const schedules = sidebar.getByRole("button", { name: "定时任务", exact: true })
    const title = "定时巡检"
    const first = "Generate the first summary"
    const second = "Generate the second summary"
    const task = page.locator(".schedules").getByRole("button", { name: title, exact: true })

    await schedules.click()
    await page
      .locator(".schedules .page-head")
      .getByRole("button", { name: "新建任务", exact: true })
      .click()
    const create = page.getByRole("button", { name: "创建任务", exact: true })
    const prompt = page.getByRole("textbox", { name: "要做什么", exact: true })
    await page.getByLabel("名字", { exact: true }).fill(title)
    await prompt.fill(first)
    await expect(create).toBeDisabled()

    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as unknown as typeof dialog.showOpenDialog
    }, project)
    await page
      .getByRole("group", { name: "运行设置" })
      .getByRole("button", { name: "添加项目", exact: true })
      .click()
    await page.getByRole("button", { name: "选择文件夹" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "添加", exact: true }).click()
    const modelChip = page.locator(".schedule-editor .model-chip")
    await expect(modelChip).toContainText("Fake Sage")
    await modelChip.click()
    await page.getByRole("option", { name: /Fake Swift/ }).click()
    await page.keyboard.press("Escape")
    const worktree = page.getByRole("switch", { name: "worktree" })
    await worktree.click()
    await expect(worktree).toBeChecked()
    await expect(create).toBeEnabled()
    await create.click()
    await expect(task).toBeVisible()
    await expect(sidebar.getByText(title, { exact: true })).toHaveCount(0)
    expect(await worktrees()).toHaveLength(0)

    const runNow = page.getByRole("button", { name: "现在运行", exact: true })
    const history = page.getByRole("tab", { name: "运行记录", exact: true })
    const rows = page.locator(".schedule-runs tbody tr")
    await task.click()
    await history.click()
    await runNow.click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText("成功")
    expect(await worktrees()).toHaveLength(1)
    await expect(sidebar.getByText(title, { exact: true })).toHaveCount(1)

    await page.getByRole("tab", { name: "设置", exact: true }).click()
    await expect(modelChip).toContainText("Fake Swift")
    await expect(worktree).toBeChecked()
    await prompt.fill(second)
    await prompt.press("End")
    await prompt.press("Enter")
    await expect(prompt).toBeVisible()
    await page.keyboard.type("@定时")
    await expect(
      page.getByRole("listbox", { name: "提到" }).getByRole("option").first(),
    ).toContainText(title)
    await page.keyboard.press("Enter")
    const mention = () => prompt.locator('.mention-chip[data-kind="thread"]')
    await expect(mention()).toHaveText(`@${title}`)
    await prompt.press("ControlOrMeta+Enter")
    await task.click()
    await expect(mention()).toHaveText(`@${title}`)
    await runNow.click()
    await history.click()
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText("成功")
    expect(await worktrees()).toHaveLength(2)
    await expect(sidebar.getByText(title, { exact: true })).toHaveCount(2)

    await rows.first().getByRole("button", { name: "打开会话" }).click()
    await expect(page.locator(".msg-user")).toContainText(second)
    await expect(page.locator(".msg-user .mention-thread")).toHaveText(title)
    await schedules.click()
    await task.click()
    await history.click()
    await rows.nth(1).getByRole("button", { name: "打开会话" }).click()
    await expect(page.locator(".msg-user")).toHaveText(first)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 4 })
  }
})
