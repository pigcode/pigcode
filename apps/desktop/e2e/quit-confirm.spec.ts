/** 退出前确认（pigcode/monorepo#65）：有任务在跑时先问，选「继续运行」不退出；没任务时直接退出。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("quitting with a running task asks first", async () => {
  // 回复前先等 5 秒：发完消息再退出时，run 一定还在跑。
  const { app, page } = await openThread("quit-confirm", {
    PIGCODE_FAKE_DELAY_MS: "5000",
    PIGCODE_QUIT_CONFIRM: "1",
  })
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type("long answer please")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "long answer please" })).toBeVisible()

    // 系统确认框换成桩：记录文案，选「继续运行」。
    await app.evaluate(({ dialog }) => {
      const prompts: string[] = []
      Object.assign(globalThis, { quitPrompts: prompts })
      dialog.showMessageBox = (async (
        windowOrOptions: unknown,
        maybeOptions?: { message: string; detail?: string },
      ) => {
        const options = maybeOptions ?? (windowOrOptions as { message: string; detail?: string })
        prompts.push(`${options.message}\n${options.detail ?? ""}`)
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const prompts = () =>
      app.evaluate(() => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts)

    // 第一次退出被取消：应用还在，run 照常跑完。
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect.poll(prompts).toHaveLength(1)
    const [first] = await prompts()
    expect(first).toContain("还有工作在运行")
    expect(first).toMatch(/\d+ 个任务正在运行或排队/)
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true)
    await expect(page.getByText("Hello from fake agent")).toBeVisible({ timeout: 30_000 })

    // 第二次退出时已经没有任务：不再问，直接退出。
    const exit = new Promise<void>((resolve) => app.process().once("exit", () => resolve()))
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await exit
    expect(await app.evaluate(() => true).catch(() => "closed")).toBe("closed")
  } finally {
    await app.close()
  }
})
