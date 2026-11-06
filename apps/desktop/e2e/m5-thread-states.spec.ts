/** M5 验收：侧栏显示排队、等待许可、失败状态，后台线程等待许可时也看得见。 */
import { expect, test, type Page } from "@playwright/test"
import { openThread } from "./projects"

/** 侧栏里某个项目下的一行会话。 */
function rows(page: Page, project: string) {
  const block = page.locator(".proj-block").filter({ hasText: project })
  return (title: string) => block.locator(".sess").filter({ hasText: title })
}

/** 在当前线程里发一条消息。 */
async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox").fill(text)
  await page.keyboard.press("Enter")
}

/** 在这个项目里再开一个会话，等 composer 可以输入。 */
async function newThread(page: Page, project: string): Promise<void> {
  await page.locator(".proj-block").filter({ hasText: project }).locator(".proj-add").click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  // 新会话的标题是默认文案；等它成为当前会话，接下来的输入才会进这一条。
  await expect(page.locator(".sess.is-active")).toHaveCount(1)
}

test("a thread beyond the run limit is queued in the sidebar", async () => {
  // 并发压到 1。第一个 run 用 fake agent 的 `long`：它一直跑到被中断，不会因为
  // 「新建线程 + 输入 + 发送」花的时间比固定延时还长而在第二个 run 之前结束。
  // 用固定延时（原来的 1500ms）时，慢一点的 CI 上窗口会过期，第二个 run 就不再排队。
  const { app, page } = await openThread("thread-queued", {
    PIGCODE_MAX_CONCURRENT_RUNS: "1",
  })
  // 断言失败时也要关掉应用：留一个还在跑 `long` 的实例会拖垮后面同 worker 的用例。
  try {
    const row = rows(page, "pigcode-e2e-thread-queued")

    await send(page, "long")
    await expect(row("long")).toHaveAttribute("data-status", "running")
    await newThread(page, "pigcode-e2e-thread-queued")
    await send(page, "second run")
    await expect(row("second run")).toHaveAttribute("data-status", "queued")

    // 中断第一个，排队的那个接着跑完。
    await row("long").click()
    await expect(page.getByRole("button", { name: "中断" })).toBeVisible()
    await page.getByRole("button", { name: "中断" }).click()
    await expect(row("second run")).toHaveAttribute("data-status", "completed", { timeout: 20_000 })
  } finally {
    await app.close()
  }
})

test("a background thread waiting for approval shows it in the sidebar", async () => {
  const { app, page } = await openThread("thread-approval", { PIGCODE_FAKE_DELAY_MS: "300" })
  const row = rows(page, "pigcode-e2e-thread-approval")

  await send(page, "approve")
  await expect(row("approve")).toHaveAttribute("data-status", "waiting-approval")

  // 切到另一个线程：后台线程的等待状态仍然显示在侧栏。
  await newThread(page, "pigcode-e2e-thread-approval")
  await expect(row("approve")).toHaveAttribute("data-status", "waiting-approval")

  // 回到那个线程处理审批，之后这一轮结束。
  await row("approve").click()
  const approval = page.getByRole("group", { name: "需要许可" })
  await expect(approval).toBeVisible()
  await approval.getByRole("button").first().click()
  await expect(row("approve")).toHaveAttribute("data-status", "completed", { timeout: 15_000 })
  await app.close()
})

test("a notice from the agent stays visible outside the folded work", async () => {
  const { app, page } = await openThread("thread-notice", { PIGCODE_FAKE_DELAY_MS: "300" })
  const row = rows(page, "pigcode-e2e-thread-notice")

  await send(page, "notice")
  // 这一轮照常结束，提示只是附带的一条信息。
  await expect(row("notice")).toHaveAttribute("data-status", "completed", { timeout: 15_000 })
  // toast 容器也是 role="status"，用类名收窄。
  const notice = page.locator(".turn-notice")
  await expect(notice).toContainText("插件工具没有接上")
  // 收起的轮里仍然看得到：提示不在工作区里。
  await expect(page.getByText("插件工具这次用不了，其余照常。")).toBeVisible()
  await app.close()
})

test("a failed run shows as failed in the sidebar and in the timeline", async () => {
  const { app, page } = await openThread("thread-failed", { PIGCODE_FAKE_DELAY_MS: "300" })
  const row = rows(page, "pigcode-e2e-thread-failed")

  await send(page, "fail")
  await expect(row("fail")).toHaveAttribute("data-status", "failed", { timeout: 15_000 })
  await expect(page.getByText("这一步没有做成：找不到要修改的文件。")).toBeVisible()
  await app.close()
})
