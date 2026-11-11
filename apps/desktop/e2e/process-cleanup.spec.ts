/** 归档线程和退出应用时，终端里跑着的进程都要结束：Host 必须真的运行清理，而不是被直接杀掉。 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { installPlugin, openThread } from "./projects"

function isAlive(pid: number): boolean {
  // process.kill(pid, 0) 分不清僵尸进程；这里要的是进程真的不在了。
  try {
    return (
      execFileSync("ps", ["-o", "stat=", "-p", String(pid)])
        .toString()
        .trim()[0] !== "Z"
    )
  } catch {
    return false
  }
}

/** 打开终端，启动一个后台进程，返回它的 pid。 */
async function startBackgroundProcess(page: Page, root: string, name: string): Promise<number> {
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
  await page.getByLabel("打开一个面板").getByRole("button", { name: /终端/ }).click()
  await expect(page.locator(".xterm")).toBeVisible()
  await page.locator(".xterm").click()
  const pidFile = join(root, `${name}.pid`)
  await page.keyboard.type(`sleep 98767 & echo $! > ${pidFile}`)
  await page.keyboard.press("Enter")
  await expect.poll(() => existsSync(pidFile)).toBe(true)
  await expect.poll(() => readFileSync(pidFile, "utf8").trim()).not.toBe("")
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  expect(isAlive(pid)).toBe(true)
  return pid
}

test.skip(process.platform === "win32", "uses POSIX job control")

test("quitting the app ends what is running in a terminal", async () => {
  const { app, page, root } = await openThread("cleanup-quit", { SHELL: "/bin/bash" })
  const pid = await startBackgroundProcess(page, root, "quit")
  await app.close()
  await expect.poll(() => isAlive(pid), { timeout: 3000 }).toBe(false)
})

test("archiving a thread ends what is running in its terminal", async () => {
  const { app, page, root } = await openThread("cleanup-archive", { SHELL: "/bin/bash" })
  // 终端在新会话草稿里打开：Host 上它属于项目。发出第一条消息后它交给新会话，
  // 归档这个会话时也要结束它里面的进程。
  const pid = await startBackgroundProcess(page, root, "archive")
  await page.locator(".tiptap").click()
  await page.keyboard.type("hello")
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: "hello" })).toBeVisible()
  expect(isAlive(pid)).toBe(true)
  await page.locator(".sess").first().click({ button: "right" })
  await page.getByRole("menuitem", { name: "归档" }).click()
  await expect.poll(() => isAlive(pid), { timeout: 5000 }).toBe(false)
  await app.close()
})

test("the app still quits when Host has just crashed", async () => {
  const { app } = await openThread("cleanup-crashed")
  // 等 Host 真正退出，但赶在 main 重启它之前退出应用。
  const hostPid = await app.evaluate(async ({ app }) => {
    // 网络服务也是 Utility 进程；Host 是其中跑 Node 的那个。
    const before = app
      .getAppMetrics()
      .find((metric) => metric.serviceName === "node.mojom.NodeService")?.pid
    app.emit("pigcode:test-kill-host")
    return before
  })
  expect(hostPid).toBeDefined()
  await expect.poll(() => isAlive(hostPid ?? 0), { intervals: [10] }).toBe(false)
  await app.close()
})

// 只杀 Host 的话，PTY 关闭也会给 shell 发 SIGHUP，上面的用例分辨不出来；这里直接看清理有没有跑完。
test("quitting the app waits for a plugin's asynchronous cleanup", async () => {
  const dir = "/tmp/pigcode-cleanup-marker-plugin"
  const marker = `${dir}/disposed`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    `${dir}/package.json`,
    JSON.stringify({
      name: "pigcode-cleanup-marker",
      version: "1.0.0",
      type: "module",
      pigcode: {
        apiVersion: 1,
        kind: "ui",
        host: "./index.mjs",
        provides: ["ui:cleanup-marker"],
      },
    }),
  )
  writeFileSync(
    `${dir}/index.mjs`,
    `import { writeFileSync } from "node:fs"
     export const name = "pigcode-cleanup-marker"
     export function apply(ctx) {
       ctx.effect(() => async () => {
         await new Promise((resolve) => setTimeout(resolve, 300))
         writeFileSync(${JSON.stringify(marker)}, "disposed")
       })
     }\n`,
  )
  const { app, page } = await openThread("cleanup-plugin")
  await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
  await installPlugin(page, dir)
  await expect(page.locator(".market-tile[data-plugin='pigcode-cleanup-marker']")).toBeVisible()
  await app.close()
  expect(existsSync(marker)).toBe(true)
})
