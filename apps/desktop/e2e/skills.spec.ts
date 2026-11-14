/** Skill 从 Agent 目录经 Host、输入框筛选到消息发送的完整链路。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("skills: search Matt inline, preserve its invocation and keep slash commands separate", async () => {
  const { app, page } = await openThread("skills")
  try {
    const editor = page.locator(".tiptap")
    await editor.fill("Help me $matt")
    const skills = page.getByRole("listbox", { name: "Skill", exact: true })
    const matt = skills.getByRole("option", { name: /Ask Matt/ })
    await expect(matt).toContainText("Pick a workflow")
    await expect(matt).toContainText("插件")
    await expect(matt).toHaveAttribute("title", /\$mattpocock-skills:ask-matt/)
    await page.keyboard.press("Tab")
    await expect(editor).toHaveText("Help me $mattpocock-skills:ask-matt ")
    await page.keyboard.type("review this project")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user")).toHaveText(
      "Help me $mattpocock-skills:ask-matt review this project",
    )
    await expect(page.locator(".msg-ai")).toContainText("Hello from fake agent")

    // 描述字段也可检索；上下文切换到已有会话后目录仍然可用。
    await editor.fill("$engineering")
    await expect(skills.getByRole("option", { name: /Ask Matt/ })).toBeVisible()
    await page.keyboard.press("Escape")
    await editor.fill("/")
    const commands = page.getByRole("listbox", { name: "命令", exact: true })
    await expect(commands.getByRole("option").filter({ hasText: "/fake-skill" })).toBeVisible()
    await expect(commands.getByRole("option").filter({ hasText: "Ask Matt" })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await editor.fill("")
  } finally {
    await app.close()
  }
})
