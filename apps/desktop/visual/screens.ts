/**
 * 视觉用例走过的界面：固定的项目、启动方式和三段操作流程。visual.spec.ts 在每一步截图，
 * e2e/english.spec.ts 用英文界面走同一遍，检查每一步的文字。按钮和标题的名字从语言包里取，
 * 两种语言走的是同一套步骤。
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"
import { enUS } from "../../../packages/ui-primitives/src/locale/messages.en-US"
import { zhCN } from "../../../packages/ui-primitives/src/locale/messages.zh-CN"

export type Theme = "light" | "dark"
export type Locale = "zh-CN" | "en-US"
type MessageKey = keyof typeof zhCN

/** 固定的项目路径：它会出现在对话框、命令面板和侧栏里。 */
export const PROJECT_ROOT = "/tmp/pigcode-visual/demo-project"
/** 不存在的 CLI：不管机器上装没装 Claude Code 和 Codex，检测结果都一样。 */
const MISSING_CLI = "/tmp/pigcode-visual/missing"

/** 示例 UI 插件右栏标签里的一段文字；插件用 useLocale() 读到语言后自己切换文案。 */
const PLUGIN_HOST_TEXT: Record<Locale, string> = { "zh-CN": "宿主", "en-US": "Host" }

const examples = (name: string) => new URL(`../../../examples/${name}`, import.meta.url).pathname

/** 一种语言的文案读取函数。 */
function translator(locale: Locale): (key: MessageKey) => string {
  const messages: Record<MessageKey, string> = locale === "en-US" ? enUS : zhCN
  return (key) => messages[key]
}

/** 去掉文案末尾的省略号，用来判断「正在读取…」这类提示是否消失。 */
const withoutEllipsis = (text: string) => text.replace(/…$/, "")

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 以某段文案开头的名字，例如启动器里「浏览器 B」这样带快捷键的按钮。 */
const startsWith = (text: string) => new RegExp(`^${escapeRegExp(text)}`)
/** 包含某段文案的名字。 */
const contains = (text: string) => new RegExp(escapeRegExp(text))

/** 准备一个固定内容的 git 仓库，工作区里留一处改动。 */
export function prepareProject(): void {
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

/**
 * 启动应用，等主题和界面语言应用到根元素，避免截到切换前的画面。每次都用新的用户 profile 和
 * Electron 数据目录。界面语言在渲染进程启动时从 localStorage 读取，而重新加载页面拿不回 Host 的
 * 连接，所以不是中文时先启动一次写入语言，再用同一个数据目录重新启动。
 */
export async function launch(
  theme: Theme,
  locale: Locale = "zh-CN",
): Promise<{ app: ElectronApplication; page: Page }> {
  const work = mkdtempSync(join(tmpdir(), "pigcode-visual-"))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const start = async () => {
    const app = await electron.launch({
      args: [`--user-data-dir=${join(work, "user-data")}`, "."],
      env: {
        ...env,
        PIGCODE_PROFILE_DIR: join(work, "profile"),
        PIGCODE_AGENT: "fake",
        PIGCODE_QUIT_CONFIRM: "0",
        PIGCODE_FAKE_STEP_MS: "40",
        PIGCODE_CLAUDE_PATH: join(MISSING_CLI, "claude"),
        PIGCODE_CODEX_PATH: join(MISSING_CLI, "codex"),
      },
    })
    const page = await app.firstWindow()
    await page.emulateMedia({ colorScheme: theme })
    await page.waitForSelector(".app")
    return { app, page }
  }
  let { app, page } = await start()
  if (locale !== "zh-CN") {
    await page.evaluate((value) => window.localStorage.setItem("pigcode.locale", value), locale)
    await app.close()
    ;({ app, page } = await start())
  }
  await page.waitForSelector(`html[data-theme="${theme}"]`)
  await page.waitForSelector(`html[lang="${locale}"]`)
  return { app, page }
}

/** 走一遍流程需要的东西；step 在每个要截图或检查文字的地方调用一次。 */
export interface Walk {
  app: ElectronApplication
  page: Page
  locale: Locale
  step: (name: string) => Promise<void>
}

/** 走一遍「创建项目」对话框；系统文件夹选择框换成直接返回项目路径。 */
async function createProject(
  { app, page, locale }: Walk,
  onDialog?: () => Promise<void>,
): Promise<void> {
  const t = translator(locale)
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog
  }, PROJECT_ROOT)
  await page
    .getByRole("button", { name: t("nav.addProject") })
    .first()
    .click()
  await page.getByRole("button", { name: t("project.add.choose") }).click()
  await expect(
    page.getByRole("button", { name: `${t("project.add.change")} ${PROJECT_ROOT}` }),
  ).toBeVisible()
  await onDialog?.()
  await page.getByRole("button", { name: t("project.add.create"), exact: true }).click()
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

/** 外壳、输入框、菜单与对话框。 */
export async function walkShell(walk: Walk): Promise<void> {
  const { page, step } = walk
  const t = translator(walk.locale)
  await step("shell-empty")
  await createProject(walk, () => step("dialog-add-project"))
  await step("thread-new")

  await page.getByRole("button", { name: contains(t("composer.modelMenu")) }).click()
  await expect(page.getByRole("listbox", { name: "Fake Agent" }).getByRole("option")).toHaveCount(2)
  await step("menu-agent-model")

  // 权限在模型选择器的底栏里；选完全访问时选择器先关掉，再弹确认框。
  const fullAccess = contains(t("composer.permission.full"))
  await page.getByRole("button", { name: startsWith(t("composer.permission.title")) }).click()
  await expect(page.getByRole("menuitemradio", { name: fullAccess })).toBeVisible()
  await step("menu-permission")
  await page.getByRole("menuitemradio", { name: fullAccess }).click()
  const confirm = page.getByRole("button", { name: t("composer.permission.full.confirm") })
  await expect(confirm).toBeVisible()
  await step("dialog-full-access")
  await page.getByRole("button", { name: t("common.cancel") }).click()
  await expect(confirm).toBeHidden()

  await page.locator(".tiptap").click()
  await page.keyboard.type("look at @ind")
  await expect(page.getByRole("listbox", { name: t("composer.suggest.files") })).toContainText(
    "index.ts",
  )
  await step("suggest-mention")
  await page.keyboard.press("Escape")
  await clearComposer(page)
  await page.keyboard.type("/")
  await expect(page.locator(".suggest-panel")).toBeVisible()
  await step("suggest-command")
  await page.keyboard.press("Escape")
  await clearComposer(page)

  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.locator(".palette")).toBeVisible()
  await step("palette")
  await page.keyboard.press("Escape")
  await expect(page.locator(".palette")).toBeHidden()

  // 审批卡片：fake agent 收到 approve 时请求一次命令审批。
  await page.locator(".tiptap").click()
  await page.keyboard.type("approve")
  await page.keyboard.press("Enter")
  const approval = page.getByRole("group", { name: t("chat.approval.title") })
  await expect(approval).toBeVisible()
  await step("timeline-approval")
  // 决议之后这一轮才结束，后面的步骤不会被等待中的审批挡住。
  await approval.getByRole("button").first().click()
  // 决议后卡片留着显示结果，按钮消失。
  await expect(approval.getByRole("button")).toHaveCount(0)

  await page.locator(".proj-block .proj").first().click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: t("sidebar.removeProject") })).toBeVisible()
  await step("menu-project")
  await page.keyboard.press("Escape")
  await page.locator(".sess").first().click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: t("sidebar.archive") })).toBeVisible()
  await step("menu-thread")
  await page.keyboard.press("Escape")

  // 窄窗口（宽度小于 960px）：侧栏收进抽屉。放在最后，前面的截图不受窗口尺寸影响。
  await page.setViewportSize({ width: 720, height: 800 })
  await expect(page.locator(".sidebar")).toBeHidden()
  await step("shell-narrow")
  await page
    .getByRole("button", { name: t("sidebar.expand") })
    .first()
    .click()
  await expect(page.locator(".app")).toHaveClass(/is-drawer-open/)
  await step("shell-narrow-drawer")
}

/** 一轮完整的工作（fake agent 的 showcase）和右栏的每一种 Surface。 */
export async function walkWorkbench(walk: Walk): Promise<void> {
  const { page, step } = walk
  const t = translator(walk.locale)
  await createProject(walk)
  await page.locator(".tiptap").click()
  await page.keyboard.type("showcase")
  await page.keyboard.press("Enter")
  const turn = page.locator(".turn").last()
  await expect(turn).toHaveAttribute("data-status", "completed", { timeout: 60_000 })
  await expect(turn.locator(".work-toggle")).toBeEnabled()

  await scrollThread(page, 1)
  // 代码高亮是异步的（Shiki 按需加载语言），等高亮后的 token 出现再截图。
  await expect(page.locator(".code-block .tok").first()).toBeVisible()
  await step("timeline-summary")
  await turn.locator(".work-toggle").click()
  await expect(turn.locator(".tool-row").first()).toBeVisible()
  await scrollThread(page, 0)
  await step("timeline-work-top")
  await scrollThread(page, 0.5)
  await step("timeline-work-middle")

  await page
    .locator(".panel-top")
    .getByRole("button", { name: t("panel.toggleRight") })
    .click()
  const launcher = page.getByLabel(t("panel.launcher"))
  await expect(launcher).toBeVisible()
  await step("workbench-launcher")

  const pane = page.locator(".right-panel-body .surface-pane:not([hidden])")
  await launcher.getByRole("button", { name: startsWith(t("workbench.browser")) }).click()
  await expect(pane.locator('.browser-page > .browser-state[data-state="empty"]')).toBeVisible()
  await step("surface-browser")

  /** 从「添加面板」菜单打开一种 Surface；ready 出现、loading 文字消失后截图。 */
  const open = async (label: MessageKey, name: string, ready: Locator, loading?: MessageKey) => {
    await page.getByRole("button", { name: t("panel.add") }).click()
    await page.getByRole("menuitem", { name: startsWith(t(label)) }).click()
    await expect(ready).toBeVisible()
    if (loading) await expect(pane).not.toContainText(withoutEllipsis(t(loading)))
    await step(name)
  }
  const fileRow = (name: string) =>
    pane.locator('[role="treeitem"]').filter({ hasText: new RegExp(`^${name}`) })
  await open("workbench.terminal", "surface-terminal", pane.locator(".xterm"))
  await open("workbench.files", "surface-files", fileRow("README\\.md"))
  await open(
    "workbench.diff",
    "surface-diff",
    pane.locator(".workbench-diff"),
    "workbench.diff.loading",
  )
  await open("workbench.pr", "surface-pr", pane.locator(".pr-panel"), "pr.loading")
  await open("workbench.checkpoint", "surface-checkpoint", pane.locator(".checkpoint-item").first())

  await page.getByRole("button", { name: t("panel.add") }).click()
  await expect(page.locator(".surface-menu")).toBeVisible()
  await step("menu-add-panel")
  await page.keyboard.press("Escape")

  await page
    .locator(".right-panel")
    .getByRole("tab", { name: t("workbench.files") })
    .click()
  await fileRow("README\\.md").click()
  await expect(page.locator(".right-panel").getByRole("tab", { name: "README.md" })).toBeVisible()
  await expect(pane).toContainText("A small project for screenshots.")
  await expect(pane.locator(".code-line .tok").first()).toBeVisible()
  await step("surface-file-editor")

  await page.keyboard.press("Control+Backquote")
  await expect(page.locator(".terminal-drawer .xterm")).toBeVisible()
  await step("terminal-drawer")
}

/** 设置的每个分区，侧栏里的定时任务页与插件页，以及插件界面。 */
export async function walkSettings(walk: Walk): Promise<void> {
  const { page, step } = walk
  const t = translator(walk.locale)
  await createProject(walk)
  await page.getByRole("button", { name: t("settings.title"), exact: true }).click()
  await expect(page.getByRole("heading", { name: t("settings.general.pageTitle") })).toBeVisible()
  await step("settings-general")

  const section = (key: MessageKey) =>
    page
      .getByRole("button", { name: t(key), exact: true })
      .first()
      .click()
  await section("settings.appearance")
  await expect(
    page.getByRole("heading", { name: t("settings.appearance.pageTitle") }),
  ).toBeVisible()
  await step("settings-appearance")

  await section("settings.agents")
  await expect(
    page.getByRole("heading", { level: 1, name: t("settings.agents"), exact: true }),
  ).toBeVisible()
  await expect(page.locator(".agents-list").first()).toContainText("Fake Agent")
  await expect(page.locator(".agents-list").first()).not.toContainText(
    withoutEllipsis(t("agents.status.checking")),
  )
  await step("settings-agents")
  await page
    .getByRole("button", { name: t("agents.select").replace("{instance}", "Claude Code") })
    .click()
  await expect(page.locator(".agent-editor")).toBeVisible()
  await step("settings-agent-editor")

  // 定时任务和插件不在设置里：回到工作区，从侧栏进去，侧栏保持工作区导航。
  await page
    .getByRole("button", { name: t("settings.back") })
    .first()
    .click()
  const nav = (key: MessageKey) =>
    page
      .locator(".side-actions")
      .getByRole("button", { name: t(key), exact: true })
      .click()
  await nav("settings.schedules")
  await expect(
    page.getByRole("heading", { level: 1, name: t("settings.schedules.pageTitle") }),
  ).toBeVisible()
  await step("settings-schedules")

  await nav("settings.plugins")
  await expect(page.getByRole("heading", { name: t("plugins.pageTitle") })).toBeVisible()
  await expect(page.locator(".market-tile")).toHaveCount(2)
  await step("settings-plugins")

  for (const name of ["ui-debug-panel", "agent-echo", "capability-clock"]) {
    await page
      .locator(".page-head")
      .getByRole("button", { name: t("plugins.add"), exact: true })
      .click()
    await page.getByRole("menuitem", { name: new RegExp(t("plugins.add.install")) }).click()
    const dialog = page.getByRole("dialog", { name: t("plugins.install.title") })
    const input = dialog.getByLabel(t("plugins.installSpec"))
    if (name === "ui-debug-panel") {
      // 截图时填一个固定的值：真实路径随检出目录变化。
      await input.fill("/path/to/pigcode-ui-debug-panel")
      await step("dialog-install-plugin")
    }
    await input.fill(examples(name))
    await dialog.getByRole("button", { name: t("plugins.install.submit"), exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
  }
  await expect(page.locator(".market-tile")).toHaveCount(5)
  await step("settings-plugins-installed")

  await page
    .getByRole("button", {
      name: t("plugins.expand").replace("{plugin}", "pigcode-ui-debug-panel"),
    })
    .click()
  await expect(page.getByRole("dialog", { name: "pigcode-ui-debug-panel" })).toBeVisible()
  await step("dialog-plugin-details")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()

  // 还没发过消息，侧栏里没有会话：回到新会话草稿，打开右栏时才按草稿建会话。
  await page
    .locator(".side-actions")
    .getByRole("button", { name: t("nav.newThread") })
    .click()
  await expect(page.locator(".plugin-panel")).toBeVisible()
  await step("shell-plugin-panel")

  await page
    .locator(".panel-top")
    .getByRole("button", { name: t("panel.toggleRight") })
    .click()
  await page.getByRole("button", { name: t("panel.add") }).click()
  await expect(page.getByRole("menuitem", { name: /Debug Inspector/ })).toBeVisible()
  await step("menu-add-panel-plugins")
  await page.getByRole("menuitem", { name: /Debug Inspector/ }).click()
  await expect(page.locator(".right-panel-body")).toContainText(PLUGIN_HOST_TEXT[walk.locale])
  await step("surface-plugin")
}
