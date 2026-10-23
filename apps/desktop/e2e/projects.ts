/** E2E 公用步骤：通过「创建项目」对话框添加项目，在新项目里开会话。 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test"

/** 过滤 undefined，满足 Playwright env 的 string 值约束；默认用 fake provider。 */
export function launchEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PIGCODE_PROVIDER: "fake",
    ...extra,
  }
}

/** 建一个带两个源文件的项目，启动应用并在里面开一个新会话。 */
export async function openThread(
  name: string,
  extra: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; root: string }> {
  const root = `/tmp/pigcode-e2e-${name}`
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "README.md"), "# Demo\n")
  writeFileSync(join(root, "src/index.ts"), "export const answer = 42\n")
  const app = await electron.launch({ args: ["."], env: launchEnv(extra) })
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

/** 在插件管理页打开「安装插件」对话框，安装一个插件目录或 npm 包。 */
export async function installPlugin(page: Page, spec: string): Promise<void> {
  await page.getByRole("button", { name: "安装插件" }).click()
  const dialog = page.getByRole("dialog", { name: "安装插件" })
  await dialog.getByLabel("插件目录或 npm 包").fill(spec)
  await dialog.getByRole("button", { name: "安装", exact: true }).click()
  await expect(dialog).toBeHidden()
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
  await expect(page.getByRole("button", { name: `更换文件夹 ${rootPath}` })).toBeVisible()
  await page.getByRole("button", { name: "创建项目", exact: true }).click()
}
