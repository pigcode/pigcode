/** M5 验收：侧栏切换多会话，后台运行状态保持。 */
import { mkdirSync, rmSync } from "node:fs"
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject } from "./projects"

/** 过滤 undefined，满足 Playwright env 的 string 值约束。 */
function launchEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

test("keeps background runs alive across threads", async () => {
  // fake agent 增加延迟，保证切换线程时仍能观察第一个线程的运行状态。
  const projectRoot = "/tmp/pigcode-m5-e2e"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({
    args: ["."],
    env: {
      ...launchEnv(),
      PIGCODE_AGENT: "fake",
      PIGCODE_QUIT_CONFIRM: "0",
      PIGCODE_FAKE_DELAY_MS: "800",
    },
  })
  try {
    const page = await app.firstWindow()
    await addProject(app, page, projectRoot)
    const project = page.locator(".proj-block").filter({ hasText: "pigcode-m5-e2e" })
    await expect(project).toBeVisible()

    // 会话只在侧栏切换；第一条消息后线程以消息内容命名，按标题定位每一行。
    const row = (title: string) => project.locator(".sess").filter({ hasText: title })

    // 第一个线程：发送后侧栏状态点立即进入运行状态。
    await project.locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello one")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello one" })).toBeVisible()
    await expect(row("hello one")).toHaveAttribute("data-status", "running")

    // 第二个线程：第一个线程转到后台继续运行，侧栏仍显示 running。
    await project.locator(".proj-add").click()
    await expect(project.locator(".sess")).toHaveCount(2)
    await expect(row("hello one")).toHaveAttribute("data-status", "running")
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello two")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "hello two" })).toBeVisible()
    await expect(row("hello two")).toHaveAttribute("data-status", "running")
    await expect(row("hello two")).toHaveAttribute("aria-current", "page")

    // 停留在第二个线程，等后台线程完成后从侧栏切回第一个查看结果。
    await expect(row("hello one")).toHaveAttribute("data-status", "completed")
    await row("hello one").click()
    await expect(row("hello one")).toHaveAttribute("aria-current", "page")
    await expect(page.locator(".msg-user").filter({ hasText: "hello one" })).toBeVisible()
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toBeVisible()

    // 切回第二个线程，确认它自己的结果与状态，并且还能继续发送。
    await row("hello two").click()
    await expect(page.locator(".msg-user").filter({ hasText: "hello two" })).toBeVisible()
    await expect(row("hello two")).toHaveAttribute("data-status", "completed")
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello three")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toHaveCount(
      2,
    )
  } finally {
    await app.close()
  }
})
