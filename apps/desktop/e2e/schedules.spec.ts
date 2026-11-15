/** 从没有会话的项目创建任务，两次运行后分别从历史打开结果。 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { launchArgs, launchEnv } from "./projects"

test("scheduled tasks create a separate thread on each run", async () => {
  const project = await mkdtemp(join(tmpdir(), "pigcode-schedule-e2e-"))
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
    await page.getByLabel("标题", { exact: true }).fill(title)
    await page.getByLabel("指令", { exact: true }).fill(first)
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
    await page.getByRole("button", { name: "创建项目", exact: true }).click()
    await expect(create).toBeEnabled()
    await create.click()
    await expect(task).toBeVisible()
    await expect(sidebar.getByText(title, { exact: true })).toHaveCount(0)

    const runNow = page.getByRole("button", { name: "立即运行", exact: true })
    const history = page.getByRole("tab", { name: "历史", exact: true })
    const rows = page.locator(".schedule-runs tbody tr")
    await task.click()
    await history.click()
    await runNow.click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText("成功")
    await expect(sidebar.getByText(title, { exact: true })).toHaveCount(1)

    await page.getByRole("tab", { name: "设置", exact: true }).click()
    await page.getByLabel("指令", { exact: true }).fill(second)
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await task.click()
    await runNow.click()
    await history.click()
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText("成功")
    await expect(sidebar.getByText(title, { exact: true })).toHaveCount(2)

    await rows.first().getByRole("button", { name: "跳到会话" }).click()
    await expect(page.locator(".msg-user")).toHaveText(second)
    await schedules.click()
    await task.click()
    await history.click()
    await rows.nth(1).getByRole("button", { name: "跳到会话" }).click()
    await expect(page.locator(".msg-user")).toHaveText(first)
  } finally {
    await app.close()
    await rm(project, { recursive: true, force: true, maxRetries: 4 })
  }
})
