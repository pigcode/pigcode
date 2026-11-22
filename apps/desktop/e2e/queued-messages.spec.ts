import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("queues a message while running, restores a withdrawal, and resumes a stopped queue", async () => {
  const { app, page } = await openThread("queued-messages")
  try {
    const editor = page.locator(".tiptap")
    await editor.fill("long")
    await editor.press("Enter")
    const stop = page.getByRole("button", { name: "停下", exact: true })
    await expect(stop).toBeVisible()
    const queue = page.getByRole("region", { name: "待发消息" })
    await editor.fill("准备撤回的原文")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await expect(queue).toContainText("准备撤回的原文")
    await editor.fill("当前草稿")
    await queue.getByRole("button", { name: "撤回", exact: true }).click()
    await expect(editor).toContainText("当前草稿")
    await expect(editor).toContainText("准备撤回的原文")

    await editor.fill("暂停后继续的消息")
    await editor.press("Enter")
    await expect(queue).toContainText("暂停后继续的消息")
    await stop.click()
    await expect(queue).toContainText("待发队列已暂停")
    await queue.getByRole("button", { name: "继续发送", exact: true }).click()
    await expect(page.locator(".msg-user").filter({ hasText: "暂停后继续的消息" })).toBeVisible()
    await expect(queue).toHaveCount(0)
  } finally {
    await app.close()
  }
})
