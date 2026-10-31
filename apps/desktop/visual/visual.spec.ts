/**
 * 视觉回归：主要界面各截浅色和深色两张。基线只在 CI 镜像上生成（visual-baselines.yml）。
 * 每次启动都用新的用户 profile 和 Electron 数据目录：前面的用例留下的插件、localStorage 偏好
 * 会改变界面。时间、耗时、终端输出这些每次都不同的内容在截图里遮住。
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"

type Theme = "light" | "dark"

/** 固定的项目路径：它会出现在对话框、命令面板和侧栏里。 */
const PROJECT_ROOT = "/tmp/pigcode-visual/demo-project"
/** 不存在的 CLI：不管机器上装没装 Claude Code 和 Codex，检测结果都一样。 */
const MISSING_CLI = "/tmp/pigcode-visual/missing"

const examples = (name: string) => new URL(`../../../examples/${name}`, import.meta.url).pathname

/** 准备一个固定内容的 git 仓库，工作区里留一处改动。 */
function prepareProject(): void {
  rmSync(PROJECT_ROOT, { recursive: true, force: true })
  mkdirSync(join(PROJECT_ROOT, "src"), { recursive: true })
  writeFileSync(join(PROJECT_ROOT, "README.md"), "# Demo\n\nA small project for screenshots.\n")
  writeFileSync(join(PROJECT_ROOT, "src/index.ts"), "export const answer = 42\n")
  const date = "2026-01-01T00:00:00Z"
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: PROJECT_ROOT, env })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "visual@example.com")
  git("config", "user.name", "Visual")
  git("add", ".")
  git("commit", "-qm", "init")
  writeFileSync(join(PROJECT_ROOT, "src/index.ts"), "export const answer = 43\n")
}

/** 启动应用并等主题应用到根元素，避免截到主题切换前的画面。 */
async function launch(theme: Theme): Promise<{ app: ElectronApplication; page: Page }> {
  const work = mkdtempSync(join(tmpdir(), "pigcode-visual-"))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, "user-data")}`, "."],
    env: {
      ...env,
      PIGCODE_PROFILE_DIR: join(work, "profile"),
      PIGCODE_PROVIDER: "fake",
      PIGCODE_FAKE_STEP_MS: "40",
      PIGCODE_CLAUDE_PATH: join(MISSING_CLI, "claude"),
      PIGCODE_CODEX_PATH: join(MISSING_CLI, "codex"),
    },
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: theme })
  await page.waitForSelector(".app")
  await page.waitForSelector(`html[data-theme="${theme}"]`)
  return { app, page }
}

/** 每次运行都会变、但占位大小固定的区域：终端里的 shell 输出、Diff 基准下拉框。 */
function volatile(page: Page): Locator[] {
  return [page.locator(".terminal-view"), page.locator(".workbench-diff-base-select")]
}

/** 截图时额外加的样式：隐藏会变的文字（时间、耗时），见 hide-volatile.css。 */
const HIDE_VOLATILE = new URL("./hide-volatile.css", import.meta.url).pathname

/** 截当前整个窗口；用 soft 断言，一张不一致时其余的照样比对。 */
async function snap(page: Page, name: string, theme: Theme): Promise<void> {
  await expect.soft(page).toHaveScreenshot(`${name}-${theme}.png`, {
    maxDiffPixels: 0,
    animations: "disabled",
    mask: volatile(page),
    stylePath: HIDE_VOLATILE,
  })
}

/** 走一遍「创建项目」对话框；系统文件夹选择框换成直接返回项目路径。 */
async function createProject(
  app: ElectronApplication,
  page: Page,
  onDialog?: () => Promise<void>,
): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog
  }, PROJECT_ROOT)
  await page.getByRole("button", { name: "添加项目" }).first().click()
  await page.getByRole("button", { name: "选择文件夹" }).click()
  await expect(page.getByRole("button", { name: `更换文件夹 ${PROJECT_ROOT}` })).toBeVisible()
  await onDialog?.()
  await page.getByRole("button", { name: "创建项目", exact: true }).click()
  await page.locator(".proj-block").filter({ hasText: "demo-project" }).locator(".proj-add").click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
}

/** 清空输入框。 */
async function clearComposer(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
}

/** 对话区的滚动位置：0 是顶部，1 是底部。 */
async function scrollThread(page: Page, fraction: number): Promise<void> {
  await page
    .locator(".thread")
    .evaluate((el, f) => (el.scrollTop = (el.scrollHeight - el.clientHeight) * f), fraction)
}

for (const theme of ["light", "dark"] as const) {
  test(`shell, composer and dialogs ${theme}`, async () => {
    test.setTimeout(120_000)
    prepareProject()
    const { app, page } = await launch(theme)
    try {
      await snap(page, "shell-empty", theme)
      await createProject(app, page, () => snap(page, "dialog-add-project", theme))
      await snap(page, "thread-new", theme)

      await page.getByRole("button", { name: /Agent 与模型/ }).click()
      await expect(
        page.getByRole("listbox", { name: "Fake Provider" }).getByRole("option"),
      ).toHaveCount(2)
      await snap(page, "menu-agent-model", theme)
      await page.keyboard.press("Escape")

      await page.getByRole("button", { name: /^权限/ }).click()
      await expect(page.getByRole("menuitem", { name: /完全访问/ })).toBeVisible()
      await snap(page, "menu-permission", theme)
      await page.getByRole("menuitem", { name: /完全访问/ }).click()
      await expect(page.getByRole("button", { name: "开启完全访问" })).toBeVisible()
      await snap(page, "dialog-full-access", theme)
      await page.getByRole("button", { name: "取消" }).click()
      await expect(page.getByRole("button", { name: "开启完全访问" })).toBeHidden()

      await page.locator(".tiptap").click()
      await page.keyboard.type("look at @ind")
      await expect(page.getByRole("listbox", { name: "文件" })).toContainText("index.ts")
      await snap(page, "suggest-mention", theme)
      await page.keyboard.press("Escape")
      await clearComposer(page)
      await page.keyboard.type("/")
      await expect(page.locator(".suggest-panel")).toBeVisible()
      await snap(page, "suggest-command", theme)
      await page.keyboard.press("Escape")
      await clearComposer(page)

      await page.keyboard.press("ControlOrMeta+k")
      await expect(page.locator(".palette")).toBeVisible()
      await snap(page, "palette", theme)
      await page.keyboard.press("Escape")
      await expect(page.locator(".palette")).toBeHidden()

      await page.locator(".proj-block .proj").first().click({ button: "right" })
      await expect(page.getByRole("menuitem", { name: "从侧栏移除" })).toBeVisible()
      await snap(page, "menu-project", theme)
      await page.keyboard.press("Escape")
      await page.locator(".sess").first().click({ button: "right" })
      await expect(page.getByRole("menuitem", { name: "归档" })).toBeVisible()
      await snap(page, "menu-thread", theme)
      await page.keyboard.press("Escape")
    } finally {
      await app.close()
    }
  })

  test(`conversation and workbench ${theme}`, async () => {
    test.setTimeout(150_000)
    prepareProject()
    const { app, page } = await launch(theme)
    try {
      await createProject(app, page)
      await page.locator(".tiptap").click()
      await page.keyboard.type("showcase")
      await page.keyboard.press("Enter")
      const turn = page.locator(".turn").last()
      await expect(turn).toHaveAttribute("data-status", "completed", { timeout: 60_000 })
      await expect(turn.locator(".work-toggle")).toBeEnabled()

      await scrollThread(page, 1)
      // 代码高亮是异步的（Shiki 按需加载语言），等高亮后的 token 出现再截图。
      await expect(page.locator(".code-block .tok").first()).toBeVisible()
      await snap(page, "timeline-summary", theme)
      await turn.locator(".work-toggle").click()
      await expect(turn.locator(".tool-row").first()).toBeVisible()
      await scrollThread(page, 0)
      await snap(page, "timeline-work-top", theme)
      await scrollThread(page, 0.5)
      await snap(page, "timeline-work-middle", theme)

      await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
      const launcher = page.getByLabel("打开一个面板")
      await expect(launcher).toBeVisible()
      await snap(page, "workbench-launcher", theme)

      const pane = page.locator(".right-panel-body .surface-pane:not([hidden])")
      await launcher.getByRole("button", { name: /^浏览器/ }).click()
      await expect(pane.locator(".browser-page > .empty-state")).toBeVisible()
      await snap(page, "surface-browser", theme)

      /** 从「添加面板」菜单打开一种 Surface；ready 出现、loading 文字消失后截图。 */
      const open = async (label: RegExp, name: string, ready: Locator, loading?: string) => {
        await page.getByRole("button", { name: "添加面板" }).click()
        await page.getByRole("menuitem", { name: label }).click()
        await expect(ready).toBeVisible()
        if (loading) await expect(pane).not.toContainText(loading)
        await snap(page, name, theme)
      }
      const fileRow = (name: string) =>
        pane.locator('[role="treeitem"]').filter({ hasText: new RegExp(`^${name}`) })
      await open(/^终端/, "surface-terminal", pane.locator(".xterm"))
      await open(/^文件/, "surface-files", fileRow("README\\.md"))
      await open(/^Diff/, "surface-diff", pane.locator(".workbench-diff"), "正在读取 diff")
      await open(/^PR/, "surface-pr", pane.locator(".pr-panel"), "正在查询")
      await open(/^检查点/, "surface-checkpoint", pane.locator(".checkpoint-item").first())

      await page.getByRole("button", { name: "添加面板" }).click()
      await expect(page.locator(".surface-menu")).toBeVisible()
      await snap(page, "menu-add-panel", theme)
      await page.keyboard.press("Escape")

      await page.locator(".right-panel").getByRole("tab", { name: "文件" }).click()
      await fileRow("README\\.md").click()
      await expect(
        page.locator(".right-panel").getByRole("tab", { name: "README.md" }),
      ).toBeVisible()
      await expect(pane).toContainText("A small project for screenshots.")
      await expect(pane.locator(".code-line .tok").first()).toBeVisible()
      await snap(page, "surface-file-editor", theme)

      await page.keyboard.press("Control+Backquote")
      await expect(page.locator(".terminal-drawer .xterm")).toBeVisible()
      await snap(page, "terminal-drawer", theme)
    } finally {
      await app.close()
    }
  })

  test(`settings and plugins ${theme}`, async () => {
    test.setTimeout(180_000)
    prepareProject()
    const { app, page } = await launch(theme)
    try {
      await createProject(app, page)
      await page.getByRole("button", { name: "设置", exact: true }).click()
      await expect(page.getByRole("heading", { name: "通用设置" })).toBeVisible()
      await snap(page, "settings-general", theme)

      const section = (label: string) =>
        page.getByRole("button", { name: label, exact: true }).first().click()
      await section("外观")
      await expect(page.getByRole("heading", { name: "外观设置" })).toBeVisible()
      await snap(page, "settings-appearance", theme)

      await section("Agent")
      await expect(
        page.getByRole("heading", { level: 1, name: "Agent", exact: true }),
      ).toBeVisible()
      await expect(page.locator(".ext-list").first()).toContainText("Fake Provider")
      await expect(page.locator(".ext-list").first()).not.toContainText("检测中")
      await snap(page, "settings-agents", theme)
      await page.getByRole("button", { name: "展开 Claude Code 的设置" }).click()
      await expect(page.locator(".agent-editor")).toBeVisible()
      await snap(page, "settings-agent-editor", theme)

      await section("定时任务")
      await expect(page.getByRole("heading", { name: "定时任务" })).toBeVisible()
      await snap(page, "settings-schedules", theme)

      await section("插件")
      await expect(page.getByRole("heading", { name: "插件管理" })).toBeVisible()
      await expect(page.locator(".ext-item")).toHaveCount(2)
      await snap(page, "settings-plugins", theme)

      for (const name of ["ui-debug-panel", "provider-echo", "capability-clock"]) {
        await page.locator(".page-head").getByRole("button", { name: "安装插件" }).click()
        const dialog = page.getByRole("dialog", { name: "安装插件" })
        const input = dialog.getByLabel("插件目录或 npm 包")
        if (name === "ui-debug-panel") {
          // 截图时填一个固定的值：真实路径随检出目录变化。
          await input.fill("/path/to/pigcode-ui-debug-panel")
          await snap(page, "dialog-install-plugin", theme)
        }
        await input.fill(examples(name))
        await dialog.getByRole("button", { name: "安装", exact: true }).click()
        await expect(dialog).toBeHidden({ timeout: 30_000 })
      }
      await expect(page.locator(".ext-item")).toHaveCount(5)
      await snap(page, "settings-plugins-installed", theme)

      await page.getByRole("button", { name: "返回应用" }).first().click()
      await expect(page.locator(".plugin-panel")).toBeVisible()
      await snap(page, "shell-plugin-panel", theme)

      await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
      await page.getByRole("button", { name: "添加面板" }).click()
      await expect(page.getByRole("menuitem", { name: /Debug Inspector/ })).toBeVisible()
      await snap(page, "menu-add-panel-plugins", theme)
      await page.getByRole("menuitem", { name: /Debug Inspector/ }).click()
      await expect(page.locator(".right-panel-body")).toContainText("宿主")
      await snap(page, "surface-plugin", theme)
    } finally {
      await app.close()
    }
  })
}
