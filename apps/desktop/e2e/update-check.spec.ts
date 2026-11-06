/** 检查更新（pigcode/monorepo#67）：手动检查显示结果，打开下载页走系统浏览器；自动检查的开关存得住。 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { _electron as electron, expect, test } from "@playwright/test"
import { launchEnv, launchArgs } from "./projects"

/** 一个只回答 GitHub release 形状的本地服务。 */
async function releaseServer(tag: string | null): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url !== "/latest" || tag === null) {
      response.writeHead(404).end("not found")
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/pigcode/pigcode/releases/tag/${tag}`,
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}/latest`, server }
}

test("a manual check shows the new version and can open the download page", async () => {
  const { url, server } = await releaseServer("v9.9.9")
  const app = await electron.launch({
    args: launchArgs(),
    // 关掉后台检查：这个用例只测手动检查，本地服务也回答不了和当前版本相同的情况。
    env: launchEnv({ PIGCODE_UPDATE_API: url, PIGCODE_UPDATE_CHECK: "0" }),
  })
  try {
    const page = await app.firstWindow()
    // 点「打开下载页」时不要真的打开浏览器，记下地址即可。
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedUrls: opened })
      shell.openExternal = (async (target: string) => {
        opened.push(target)
      }) as typeof shell.openExternal
    })
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).first().click()
    // 自动检查默认开。
    await expect(page.getByRole("switch", { name: "自动检查更新" })).toHaveAttribute(
      "aria-checked",
      "true",
    )

    await page.getByRole("button", { name: "立即检查" }).click()
    await expect(page.getByText("有新版本 9.9.9")).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: "打开下载页" }).click()
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls),
      )
      .toEqual(["https://github.com/pigcode/pigcode/releases/tag/v9.9.9"])
  } finally {
    await app.close()
    server.close()
  }
})

test("the background check asks once and opens the download page", async () => {
  const { url, server } = await releaseServer("v9.9.9")
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ PIGCODE_UPDATE_API: url }),
  })
  try {
    // 启动后 5 秒才查；把确认框换成桩，记下文案并选「打开下载页」。
    await app.evaluate(({ dialog }) => {
      const prompts: string[] = []
      Object.assign(globalThis, { updatePrompts: prompts })
      dialog.showMessageBox = (async (
        windowOrOptions: unknown,
        maybeOptions?: { message: string },
      ) => {
        const options = maybeOptions ?? (windowOrOptions as { message: string })
        prompts.push(options.message)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    await expect
      .poll(
        () =>
          app.evaluate(() => (globalThis as unknown as { updatePrompts: string[] }).updatePrompts),
        { timeout: 20_000 },
      )
      // 只断言「提示了一次、里面带新版本号」：主进程按 app.getLocale() 选语言，
      // 而 runner 的系统语言不受这个仓库控制。文案本身由 locale 的单元测试覆盖。
      .toHaveLength(1)
    const [prompt] = await app.evaluate(
      () => (globalThis as unknown as { updatePrompts: string[] }).updatePrompts,
    )
    expect(prompt).toContain("9.9.9")
  } finally {
    await app.close()
    server.close()
  }
})

test("a failed check says so and leaves the app alone", async () => {
  const { url, server } = await releaseServer(null)
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ PIGCODE_UPDATE_API: url, PIGCODE_UPDATE_CHECK: "0" }),
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "通用", exact: true }).first().click()
    await page.getByRole("button", { name: "立即检查" }).click()
    await expect(page.getByText("检查失败，请稍后再试")).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
    server.close()
  }
})
