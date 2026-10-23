/**
 * agent 提问：时间线里出现提问卡片，选好后提交，agent 按回答继续；回答过的提问留在工作区里，
 * 是一行「已询问」（fake provider）。
 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("the agent asks questions and continues with the answers", async () => {
  const { app, page } = await openThread("questions")
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type("ask")
    await page.keyboard.press("Enter")

    const card = page.getByRole("form", { name: "Agent 想先确认几件事" })
    await expect(card).toBeVisible()
    await expect(page.getByRole("button", { name: /等待回答/ })).toBeVisible()
    const submit = card.getByRole("button", { name: "提交回答" })
    await expect(submit).toBeDisabled()
    await card.getByRole("checkbox", { name: "macOS" }).check()
    await card.getByRole("checkbox", { name: "Linux" }).check()
    await card.getByRole("radio", { name: /Vitest/ }).check()
    await submit.click()

    await expect(
      page.locator(".msg-ai").filter({ hasText: "好的：平台 macOS, Linux，测试用 Vitest。" }),
    ).toBeVisible()
    await expect(card).toHaveCount(0)
    await page.getByRole("button", { name: /已工作/ }).click()
    const asked = page.getByRole("button", { name: /已询问/ })
    await expect(asked).toContainText("2 个问题")
    await asked.click()
    await expect(page.locator(".question-done")).toContainText("macOS, Linux")
  } finally {
    await app.close()
  }
})
