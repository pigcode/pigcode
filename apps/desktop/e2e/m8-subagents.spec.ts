/** 线程头标签：主 agent 派生的子代理（只读标签）与 workflow 的阶段（fake agent）。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("spawned sub-agents get read-only tabs with their task, steps and result", async () => {
  const { app, page } = await openThread("spawned", { PIGCODE_FAKE_STEP_MS: "400" })
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type("subagents")
    await page.keyboard.press("Enter")

    // 派生时每个子代理出现一个标签，运行中显示点阵；主会话标签不显示运行状态。
    const spawned = page.locator(".thread-tab[data-kind='spawned']")
    await expect(spawned).toHaveCount(2)
    await expect(spawned.first()).toContainText("梳理入口与导出")
    await expect(spawned.first().locator(".dot-matrix")).toBeVisible()
    await expect(page.locator(".thread-tab[data-kind='main'] .dot-matrix")).toHaveCount(0)

    await expect(page.getByRole("button", { name: /已工作/ })).toBeVisible({ timeout: 20_000 })
    await expect(spawned.locator(".dot-matrix")).toHaveCount(0)
    await page.getByRole("tab", { name: "检查测试覆盖" }).click()
    await expect(page.locator(".subagent-view")).toContainText("运行 pnpm test")
    await expect(page.locator(".subagent-view-result")).toContainText("缺少对导出形状的测试")
    await expect(page.locator(".tiptap")).toHaveCount(0)

    // 关掉标签后，从时间线卡片重新打开。
    await page.getByRole("button", { name: "关闭 检查测试覆盖" }).click()
    await expect(spawned).toHaveCount(1)
    await expect(page.locator(".msg-ai").filter({ hasText: "两个子代理都完成了" })).toBeVisible()
    await page.getByRole("button", { name: /已工作/ }).click()
    await page.getByRole("button", { name: "在标签页中打开 general-purpose" }).click()
    await expect(spawned).toHaveCount(2)
    await expect(page.getByRole("tab", { name: "检查测试覆盖" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await page.getByRole("button", { name: "回到主会话" }).click()
    await expect(page.locator(".tiptap")).toBeVisible()
  } finally {
    await app.close()
  }
})

test("a workflow shows its phases and agents live, then folds into the finished turn", async () => {
  const { app, page } = await openThread("workflow", { PIGCODE_FAKE_STEP_MS: "700" })
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type("workflow")
    await page.keyboard.press("Enter")

    // 运行中：卡片自动展开，一行摘要是当前阶段和完成数，按阶段列出 agent。
    const card = page.locator(".workflow-row")
    await expect(card.locator(".tool-row-head")).toContainText("audit-exports")
    await expect(card.locator(".tool-row-head")).toContainText(/检查文件 · \d\/4 完成/)
    await expect(card.locator(".workflow-phase-title")).toHaveText(["检查文件", "汇总"])
    await expect(card.locator(".workflow-agent[data-state='running']").first()).toBeVisible()
    await expect(card.locator(".workflow-pip")).toHaveCount(4)

    // 跑完以后这一轮的工作折起来；展开看每个 agent 的结论和总用量。
    await expect(page.locator(".msg-ai").filter({ hasText: "工作流完成了" })).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole("button", { name: /已工作/ }).click()
    await expect(card.locator(".workflow-agent[data-state='done']")).toHaveCount(4)
    await expect(card.locator(".workflow-usage")).toContainText("tokens")
    await card.getByText("check:src/math.ts").click()
    await expect(card.locator(".workflow-agent-body")).toContainText("没有校验参数类型")
    await card.getByRole("button", { name: "工作流脚本" }).click()
    await expect(card.locator(".workflow-script-code")).toContainText("export const meta")
  } finally {
    await app.close()
  }
})
