/** 在输入框里 @ 引用另一个会话（pigcode/monorepo#81）：选中、发送、点气泡里的标签跳过去。 */
import { expect, test, type Page } from "@playwright/test"
import { openThread } from "./projects"

const PROJECT = "pigcode-e2e-thread-reference"

/** 在当前输入框里发一条消息，等它出现在会话里。 */
async function send(page: Page, text: string): Promise<void> {
  await page.locator(".tiptap").click()
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: text })).toBeVisible()
}

test("mentions another thread with @ and opens it from the sent message", async () => {
  const { app, page } = await openThread("thread-reference")
  try {
    const block = page.locator(".proj-block").filter({ hasText: PROJECT })
    await send(page, "整理解析器的计划")
    // 第二个会话的标题里也有这几个字，按标题精确匹配。
    const source = block
      .locator(".sess")
      .filter({ has: page.getByText("整理解析器的计划", { exact: true }) })
    await expect(source).toBeVisible()

    // 新会话里 @ 出上一个会话。
    await block.locator(".proj-add").click()
    await expect(page.locator(".new-thread-view")).toBeVisible()
    await page.locator(".tiptap").click()
    await page.keyboard.type("接着做 @解析器")
    const list = page.getByRole("listbox", { name: "引用" })
    await expect(list.getByRole("option").first()).toContainText("整理解析器的计划")
    await page.keyboard.press("Enter")
    await expect(page.locator('.tiptap .mention-chip[data-kind="thread"]')).toHaveText(
      "@整理解析器的计划",
    )
    await page.keyboard.type(" 剩下的部分")
    await page.keyboard.press("Enter")

    // 发出去的消息里是可点的会话标签，点一下回到那个会话。
    const sent = page.locator(".msg-user").filter({ hasText: "剩下的部分" })
    const chip = sent.locator(".mention-thread")
    await expect(chip).toHaveText("整理解析器的计划")
    await chip.click()
    await expect(source).toHaveClass(/is-active/)
    await expect(page.locator(".msg-user").filter({ hasText: "整理解析器的计划" })).toBeVisible()

    // 侧栏的右键菜单：在当前会话的输入框里插入另一个会话的引用。
    const other = block.locator(".sess").filter({ hasText: "接着做" })
    await other.click({ button: "right" })
    await page.getByRole("menuitem", { name: "在输入框里引用" }).click()
    await expect(page.locator('.tiptap .mention-chip[data-kind="thread"]')).toContainText("@接着做")
  } finally {
    await app.close()
  }
})
