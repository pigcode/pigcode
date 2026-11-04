/**
 * 实验（pigcode/pigcode#19）：开启架构文档 §10.3 的 CSP 后，打开主要页面并收集控制台报错。
 * 只记录，不修；这个文件只存在于 experiment/csp 分支。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import { startDemoSite } from "./demo-site"
import { addProject, installPlugin, launchEnv } from "./projects"

/** 控制台里可能是 CSP 拦截的消息；不只匹配 "Refused to"，Electron 的文案会变。 */
const SUSPECT = /content security policy|refused to|csp|blocked by|violat/i

/** 收集到的控制台消息与失败步骤。 */
const violations = new Set<string>()
const pageErrors = new Set<string>()
const failedSteps = new Map<string, string>()

function watch(page: Page): void {
  page.on("console", (message) => {
    const text = message.text()
    if (SUSPECT.test(text)) violations.add(text)
  })
  page.on("pageerror", (error) => pageErrors.add(error.message))
}

/** 单步失败或卡住都不打断实验，记下来继续。 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  const started = Date.now()
  let timer: NodeJS.Timeout | undefined
  try {
    // 有些定位器即使设置了默认超时也会一直等；这里再兜一层硬上限。
    await Promise.race([
      run().finally(() => clearTimeout(timer)),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("step timed out after 15s")), 15_000)
      }),
    ])
    console.log(`[csp] ${name}: ok (${Date.now() - started}ms)`)
  } catch (error) {
    failedSteps.set(name, error instanceof Error ? error.message : String(error))
    console.log(`[csp] ${name}: failed (${Date.now() - started}ms)`)
  }
}

test("collect CSP violations across the main surfaces", async () => {
  // 数据采集用例：只有显式设置 PIGCODE_CSP=1 时才跑，避免拖慢常规 E2E。
  test.skip(process.env.PIGCODE_CSP !== "1", "set PIGCODE_CSP=1 to collect CSP violations")
  test.setTimeout(300_000)
  const root = "/tmp/pigcode-csp"
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "README.md"), "# CSP demo\n")
  writeFileSync(join(root, "src/index.ts"), "export const answer = 42\n")

  const site = await startDemoSite()
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    env: launchEnv({ PIGCODE_FAKE_STEP_MS: "20" }),
  })
  const page = await app.firstWindow()
  watch(page)
  // 单个步骤最多等 8 秒，找不到元素时记下来继续下一项，不让一个选择器拖垮整次实验。
  page.setDefaultTimeout(8_000)

  try {
    await step("add project", () => addProject(app, page, root))
    await step("open thread", async () => {
      await page
        .locator(".proj-block")
        .filter({ hasText: "pigcode-csp" })
        .locator(".proj-add")
        .click()
      await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    })
    await step("send a message", async () => {
      await page.locator(".tiptap").click()
      await page.keyboard.type("tools")
      await page.keyboard.press("Enter")
      await expect(page.locator(".msg-user").filter({ hasText: "tools" })).toBeVisible()
      await expect(page.locator(".msg-ai").first()).toBeVisible({ timeout: 30_000 })
    })
    await step("file panel", async () => {
      await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
      await page.getByLabel("打开一个面板").getByRole("button", { name: /文件/ }).click()
      // 启动器是 Base UI 的浮层，选完按 Esc 收起，否则后面的点击会被它的遮罩挡住。
      await page.keyboard.press("Escape")
      await page
        .locator('.files-surface [role="treeitem"]')
        .filter({ hasText: /^README\.md/ })
        .click()
      await expect(page.locator(".file-surface")).toContainText("CSP demo")
    })
    await step("browser panel", async () => {
      // 先开浏览器再开终端：xterm 会抢走键盘，之后按 b 就打不开浏览器了。
      await page.locator(".right-panel-body").click({ position: { x: 8, y: 8 } })
      await page.keyboard.press("b")
      const address = page.getByRole("textbox", { name: /输入网址/ })
      await address.fill(site.url)
      await address.press("Enter")
      await expect(page.getByRole("tab", { name: new URL(site.url).host })).toBeVisible()
    })
    await step("terminal panel", async () => {
      await page.getByRole("button", { name: "添加面板" }).click()
      await page.getByRole("menuitem", { name: /终端/ }).click()
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 10_000 })
    })
    await step("settings pages", async () => {
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "设置", exact: true }).click()
      for (const name of ["通用", "外观", "Agent", "插件", "快捷键", "关于"]) {
        const entry = page.getByRole("button", { name, exact: true })
        if (await entry.count()) await entry.first().click()
      }
    })
    await step("install sample plugin", async () => {
      await page.getByRole("button", { name: "返回应用" }).first().click()
      await page.getByRole("button", { name: "设置", exact: true }).click()
      await page.getByRole("button", { name: "插件", exact: true }).first().click()
      await installPlugin(
        page,
        new URL("../../../examples/ui-debug-panel", import.meta.url).pathname,
      )
      await expect(page.getByText("Debug Panel")).toBeVisible()
    })
    await step("plugin panel", async () => {
      await page.getByRole("button", { name: "返回应用" }).first().click()
      await page.getByRole("button", { name: "切换右侧面板" }).first().click()
      await page.getByRole("button", { name: "Debug Inspector" }).click()
      await expect(page.locator("[data-plugin-content='debug-inspector']")).toBeVisible()
    })
    await step("reload", async () => {
      await page.reload()
      await expect(page.locator(".app")).toBeVisible()
    })
  } finally {
    const result = {
      violations: [...violations],
      pageErrors: [...pageErrors],
      failedSteps: Object.fromEntries(failedSteps),
    }
    writeFileSync("/tmp/csp-result.json", JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    await app.close().catch(() => undefined)
    await site.close().catch(() => undefined)
  }
})
