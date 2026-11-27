/** E2E 公用步骤：通过「创建项目」对话框添加项目，在新项目里开会话。 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"

/**
 * 过滤 undefined，满足 Playwright env 的 string 值约束；默认用 fake agent。
 * 退出确认默认关掉：等待审批的用例会在应用退出时撞上原生确认框，把测试卡住；
 * 退出确认自己的用例传 PIGCODE_QUIT_CONFIRM=1 打开。
 */
export function launchEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PIGCODE_AGENT: "fake",
    PIGCODE_QUIT_CONFIRM: "0",
    ...extra,
  }
}

/**
 * 启动参数。`--lang=zh-CN` 固定主进程的语言：对话框文案走 app.getLocale()，
 * 而 CI 的 runner 是英文环境、本地 macOS 是中文，不固定的话断言会随环境变。
 */
export function launchArgs(extra: string[] = []): string[] {
  return [".", "--lang=zh-CN", ...extra]
}

/** 建一个带两个源文件的项目，启动应用并在里面进入新会话草稿；第一条消息发出去时才建会话。 */
export async function openThread(
  name: string,
  extra: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; root: string }> {
  const root = `/tmp/pigcode-e2e-${name}`
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "README.md"), "# Demo\n")
  writeFileSync(join(root, "src/index.ts"), "export const answer = 42\n")
  // 固定语言：主进程的对话框按 app.getLocale() 选文案，而 CI 的 runner 是英文环境、
  // 本地 macOS 是中文，不固定的话断言会随运行环境变。
  const app = await electron.launch({ args: launchArgs(), env: launchEnv(extra) })
  const page = await app.firstWindow()
  await addProject(app, page, root)
  await page
    .locator(".proj-block")
    .filter({ hasText: `pigcode-e2e-${name}` })
    .locator(".proj-add")
    .click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  return { app, page, root }
}

/**
 * 拿到会话详情卡：会话区够宽时它钉在右上角、默认开着；窄的时候点线程头的按钮，从浮层里弹出来。
 * 按钮的名字在待办没做完时带着进度，所以只按开头匹配。
 */
export async function openThreadDetails(page: Page): Promise<Locator> {
  const toggle = page.locator(".panel-top").getByRole("button", { name: /^会话详情/ })
  await expect(toggle).toBeVisible()
  const pinned = page.getByRole("complementary", { name: "会话详情" })
  if (await pinned.isVisible()) return pinned
  const popup = page.getByRole("dialog", { name: "会话详情" })
  if (await popup.isVisible()) return popup
  await toggle.click()
  await expect(popup).toBeVisible()
  return popup
}

/** 收起浮层里的详情卡，再点一下线程头的按钮；钉住的卡片留着。 */
export async function closeThreadDetails(page: Page): Promise<void> {
  const popup = page.getByRole("dialog", { name: "会话详情" })
  if (!(await popup.isVisible())) return
  await page
    .locator(".panel-top")
    .getByRole("button", { name: /^会话详情/ })
    .click()
  await expect(popup).toBeHidden()
}

/**
 * 下一次弹出的系统菜单（侧栏的右键菜单）直接选 label 这一项，之后恢复原样；
 * 系统菜单不在页面里，Playwright 点不到。
 */
export async function pickNextMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const original = Menu.buildFromTemplate.bind(Menu)
    Menu.buildFromTemplate = (template) => {
      Menu.buildFromTemplate = original
      return {
        popup(options: { callback?: () => void }) {
          const item = template.find((entry) => entry.label === wanted)
          if (typeof item?.click === "function") (item.click as () => void)()
          options.callback?.()
        },
      } as ReturnType<typeof Menu.buildFromTemplate>
    }
  }, label)
}

/** 在插件页标题栏的「添加」里打开「安装插件」对话框，安装一个插件目录、npm 包或 GitHub 仓库。 */
export async function openInstallDialog(page: Page): Promise<void> {
  await page.locator(".page-head").getByRole("button", { name: /^添加/ }).click()
  await page.getByRole("menuitem", { name: /安装插件/ }).click()
}

/** 在插件页安装一个插件目录、npm 包或 GitHub 仓库。 */
export async function installPlugin(page: Page, spec: string): Promise<void> {
  await openInstallDialog(page)
  const dialog = page.getByRole("dialog", { name: "安装插件" })
  await dialog.getByLabel("GitHub 仓库、npm 包或文件夹").fill(spec)
  await dialog.getByRole("button", { name: "安装", exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** 打开「设置 → 插件」；已处于设置侧栏时直接切到插件页。 */
export async function openPluginsSettings(page: Page, manage = false): Promise<void> {
  const settingsBtn = page.getByRole("button", { name: /^(设置|Settings)$/, exact: true })
  const backBtn = page.getByRole("button", { name: /^(返回应用|Back to app)$/, exact: true })
  await expect(settingsBtn.or(backBtn).first()).toBeVisible()
  if (await settingsBtn.isVisible()) {
    await settingsBtn.click()
  }
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^(插件|Plugins)$/, exact: true })
    .click()
  if (manage) {
    await page.getByRole("button", { name: "插件管理", exact: true }).click()
  }
}

/** 如果当前在设置页，返回工作区侧栏。 */
export async function backFromSettings(page: Page): Promise<void> {
  const back = page.getByRole("button", { name: /^(返回应用|Back to app)$/ }).first()
  if (await back.isVisible().catch(() => false)) {
    await back.click()
  }
}

/**
 * 系统文件夹选择框无法由 Playwright 操作，先在主进程里把它换成直接返回 rootPath，
 * 再走对话框的完整流程：添加项目 → 选择文件夹 → 创建项目。
 */
export async function addProject(
  app: ElectronApplication,
  page: Page,
  rootPath: string,
): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog
  }, rootPath)
  await page.getByRole("button", { name: "添加项目" }).first().click()
  await page.getByRole("button", { name: "选择文件夹" }).click()
  await expect(page.getByRole("button", { name: `换文件夹 ${rootPath}` })).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "添加", exact: true }).click()
}
