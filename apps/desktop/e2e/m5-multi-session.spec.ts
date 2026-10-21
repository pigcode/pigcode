/** M5 验收：多会话 tab、后台运行状态与关闭 tab。 */
import { mkdirSync, rmSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"

/** 过滤 undefined，满足 Playwright env 的 string 值约束。 */
function launchEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

test("keeps background runs alive across tabs", async () => {
  // fake provider 增加延迟，保证切 tab 时仍能观察第一个线程的运行状态。
  const projectRoot = "/tmp/pigcode-m5-e2e"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({
    args: ["."],
    env: {
      ...launchEnv(),
      PIGCODE_PROVIDER: "fake",
      PIGCODE_FAKE_DELAY_MS: "800",
    },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole("button", { name: "添加项目" }).first().click()
    await page.getByLabel("项目路径").fill(projectRoot)
    await page.getByRole("button", { name: "添加", exact: true }).click()
    const project = page.locator(".proj-block").filter({ hasText: "pigcode-m5-e2e" })
    await expect(project).toBeVisible()

    const tabs = page.locator(".thread-tab")
    // 第一个线程：发送后 tab 立即进入运行状态。
    await project.locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello one")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello one" })).toBeVisible()
    await expect(tabs).toHaveCount(1)
    await expect(tabs.nth(0).locator(".tab-status")).toHaveAttribute("data-status", "running")

    // 第二个线程：第一个线程转到后台继续运行，tab 仍显示 running。
    await project.locator(".proj-add").click()
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(0).locator(".tab-status")).toHaveAttribute("data-status", "running")
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello two")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello two" })).toBeVisible()
    await expect(tabs.nth(1).locator(".tab-status")).toHaveAttribute("data-status", "running")

    // 停留在第二个 tab，等后台线程完成后切回第一个查看结果。
    await expect(tabs.nth(0).locator(".tab-status")).toHaveAttribute("data-status", "completed")
    await tabs.nth(0).click()
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true")
    await expect(
      page.locator(".msg-ai").filter({ hasText: "Hello from fake provider" }),
    ).toBeVisible()

    // 切回第二个 tab，确认它自己的结果与状态。
    await tabs.nth(1).click()
    await expect(
      page.locator(".msg-ai").filter({ hasText: "Hello from fake provider" }),
    ).toBeVisible()
    await expect(tabs.nth(1).locator(".tab-status")).toHaveAttribute("data-status", "completed")

    // 关闭后台 tab 不崩溃，剩余线程仍可继续发送。
    await tabs.nth(0).locator(".tab-close").click()
    await expect(tabs).toHaveCount(1)
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello three")
    await page.keyboard.press("Enter")
    await expect(
      page.locator(".msg-ai").filter({ hasText: "Hello from fake provider" }),
    ).toHaveCount(2)

    // 关闭活动 tab 后回到空状态，应用仍可创建新会话。
    await tabs.nth(0).locator(".tab-close").click()
    await expect(tabs).toHaveCount(0)
    await expect(page.getByRole("button", { name: "新会话" }).first()).toBeVisible()
  } finally {
    await app.close()
  }
})
