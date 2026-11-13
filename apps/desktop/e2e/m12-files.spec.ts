/** 文件导航与预览：双列、窄面板、标签、原生文件操作、Git 筛选和编辑保存。 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import { addProject, launchEnv, launchArgs } from "./projects"

/** 一个带 git 历史、忽略目录、嵌套目录与图片的项目。 */
function createProject(): string {
  const root = "/tmp/pigcode-e2e-files"
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, "src", "components"), { recursive: true })
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true })
  writeFileSync(join(root, ".gitignore"), "node_modules/\n")
  writeFileSync(join(root, "README.md"), "# Files demo\n")
  writeFileSync(join(root, "src", "index.ts"), "export const answer: number = 42\n")
  writeFileSync(join(root, "src", "components", "file-tree.tsx"), "export function Tree() {}\n")
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
  writeFileSync(
    join(root, "logo.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  )
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root })
  return root
}

/** 资源管理器里的一行。 */
function row(page: Page, scope: string, name: string) {
  return page.locator(`${scope} [role="treeitem"]`).filter({ hasText: new RegExp(`^${name}`) })
}

/** 从项目行打开文件面板；此时只有草稿。 */
async function openFilesPanel(app: ElectronApplication, root: string): Promise<Page> {
  const page = await app.firstWindow()
  await addProject(app, page, root)
  await page
    .locator(".proj-block")
    .filter({ hasText: "pigcode-e2e-files" })
    .getByRole("button", { name: "查看文件" })
    .click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await expect(page.getByRole("tab", { name: "文件" })).toBeVisible()
  await expect(page.locator(".sess")).toHaveCount(0)
  return page
}

test("file explorer: browse, open, edit, save, search and refresh", async () => {
  const root = createProject()
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ PIGCODE_FAKE_STEP_MS: "50" }),
  })
  try {
    // 打开文件树：目录在前，被 .gitignore 忽略的 node_modules 淡化显示。
    const page = await openFilesPanel(app, root)
    const tree = ".file-surface-aside"
    await expect(page.getByText("从目录中选择一个文件")).toBeVisible()
    await expect(page.locator(`${tree} [role="treeitem"]`)).toHaveText([
      "node_modules",
      "src",
      ".gitignore",
      "logo.png",
      "README.md",
    ])
    await expect(row(page, tree, "node_modules")).toHaveAttribute("data-ignored", "true")

    // 展开 src：只有一个子目录的链合并成一行。
    await row(page, tree, "src").click()
    await expect(row(page, tree, "components")).toBeVisible()
    await expect(row(page, tree, "index.ts")).toBeVisible()
    await page.screenshot({ path: "test-results/files-explorer.png" })

    // 单击复用预览标签；显式打开则保留为单独标签。
    await row(page, tree, "index.ts").click()
    const tabs = page.locator(".right-panel").getByRole("tab")
    await expect(tabs).toHaveText(["index.ts"])
    const editor = page.getByRole("textbox", { name: "文件内容 src/index.ts" })
    await expect(editor).toHaveValue("export const answer: number = 42\n")
    await expect(page.locator(".code-layer .tok").first()).toBeVisible()
    await expect(row(page, ".file-surface-aside", "index.ts")).toHaveAttribute(
      "data-active",
      "true",
    )
    await row(page, ".file-surface-aside", "README.md").click()
    await expect(tabs).toHaveText(["README.md"])
    await expect(
      page.locator(".file-markdown-preview").getByRole("heading", { name: "Files demo" }),
    ).toBeVisible()
    await page.getByRole("button", { name: "源码", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "文件内容 README.md" })).toHaveValue(
      "# Files demo\n",
    )
    await page.getByRole("button", { name: "预览", exact: true }).click()
    await expect(
      page.locator(".file-markdown-preview").getByRole("heading", { name: "Files demo" }),
    ).toBeVisible()
    await row(page, tree, "index.ts").click({ modifiers: ["ControlOrMeta"] })
    await expect(tabs).toHaveText(["README.md", "index.ts"])

    // 调整右栏到最窄时，目录和文件在同一内容区切换。
    const rightResize = page.getByRole("separator", { name: "右侧面板" })
    await rightResize.press("Home")
    await page.getByRole("button", { name: "显示文件导航" }).click()
    await expect(page.locator(".files-surface[data-navigation-only]")).toBeVisible()
    await expect(editor).toBeHidden()
    await row(page, tree, "index.ts").click()
    await expect(editor).toBeVisible()
    await rightResize.dblclick()

    // 面板最大化后足够宽，文件树停靠在左侧。
    await page.locator(".right-panel-bar").getByRole("button", { name: "最大化面板" }).click()
    await expect(page.locator(".file-surface-aside")).toBeVisible()
    const directoryResize = page.getByRole("separator", { name: "调整文件目录宽度" })
    const startWidth = Number(await directoryResize.getAttribute("aria-valuenow"))
    await directoryResize.press("ArrowRight")
    await expect(directoryResize).toHaveAttribute("aria-valuenow", String(startWidth + 24))
    await page.getByRole("button", { name: "收起文件导航" }).click()
    await expect(directoryResize).toHaveCount(0)
    await expect(editor).toBeVisible()
    await page.getByRole("button", { name: "显示文件导航" }).click()
    await expect(directoryResize).toHaveAttribute("aria-valuenow", String(startWidth + 24))

    // 在原生文件菜单选择另存为，验证二进制文件逐字节复制。
    const copiedImage = join(root, "saved-copy.png")
    await app.evaluate(({ Menu, dialog, shell }, destination) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedWorkspaceFiles: opened })
      const popup = Menu.prototype.popup
      Menu.prototype.popup = function (this: InstanceType<typeof Menu>, options) {
        const choice = this.items.find(
          (item) => item.label === "另存为…" || item.label === "关闭其他标签",
        )
        if (!choice) return popup.call(this, options)
        choice.click({}, options?.window)
        options?.callback?.()
      }
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: destination,
      })) as typeof dialog.showSaveDialog
      shell.openPath = async (path) => {
        opened.push(path)
        return ""
      }
    }, copiedImage)
    await row(page, tree, "logo.png").click({ button: "right" })
    await expect
      .poll(() => {
        try {
          return readFileSync(copiedImage).toString("base64")
        } catch {
          return ""
        }
      })
      .toBe(readFileSync(join(root, "logo.png")).toString("base64"))
    await page.getByRole("button", { name: "使用系统默认应用打开" }).click()
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { openedWorkspaceFiles: string[] }).openedWorkspaceFiles,
        ),
      )
      .toEqual([expect.stringMatching(/[/\\]src[/\\]index\.ts$/)])
    rmSync(copiedImage)

    // 编辑后标签出现未保存圆点；⌘S 保存到磁盘，再次修改别处的内容时提示冲突。
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("export const extra = true")
    await expect(page.locator(".surface-tab-dirty")).toBeVisible()
    await expect(page.getByText("未保存")).toBeVisible()
    await page.keyboard.press("Control+s")
    await expect(page.locator(".surface-tab-dirty")).toHaveCount(0)
    expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toBe(
      "export const answer: number = 42\nexport const extra = true",
    )
    // 保存后 git 状态刷新：改过的文件标成 M。
    await expect(row(page, ".file-surface-aside", "index.ts").locator(".fx-git")).toHaveText("M")
    writeFileSync(join(root, "src", "new-component.ts"), "export {}\n")
    rmSync(join(root, "logo.png"))
    await page.getByRole("button", { name: "刷新文件树" }).click()
    await page.getByRole("button", { name: "仅显示变更文件" }).click()
    await expect(row(page, tree, "README.md")).toHaveCount(0)
    await expect(row(page, tree, "index.ts")).toBeVisible()
    await expect(row(page, tree, "new-component.ts")).toHaveAttribute("data-git", "untracked")
    await expect(row(page, tree, "logo.png")).toHaveAttribute("data-git", "deleted")
    writeFileSync(
      join(root, "logo.png"),
      execFileSync("git", ["show", "HEAD:logo.png"], { cwd: root }),
    )
    await page.getByRole("button", { name: "显示全部文件" }).click()
    await page.getByRole("button", { name: "刷新文件树" }).click()
    await page.screenshot({ path: "test-results/files-editor.png" })

    await editor.click()
    await editor.press("Control+End")
    await editor.press("Enter")
    await page.keyboard.type("// mine")
    await expect(page.locator(".surface-tab-dirty")).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 30))
    writeFileSync(join(root, "src", "index.ts"), "// changed elsewhere\n")
    await page.keyboard.press("Control+s")
    await expect(
      page.getByRole("alert").filter({ hasText: "这个文件在磁盘上被修改过" }),
    ).toBeVisible()
    await page.getByRole("button", { name: "放弃修改并重新加载" }).click()
    await expect(editor).toHaveValue("// changed elsewhere\n")

    // 搜索：模糊匹配文件名，点开另一个文件标签。
    const search = page.locator(".file-surface-aside").getByRole("searchbox", { name: "搜索文件" })
    await search.fill("ftree")
    await expect(row(page, ".file-surface-aside", "file-tree.tsx")).toBeVisible()
    await expect(
      row(page, ".file-surface-aside", "file-tree.tsx").locator(".fx-match").first(),
    ).toBeVisible()
    await row(page, ".file-surface-aside", "file-tree.tsx").click({ modifiers: ["ControlOrMeta"] })
    await expect(tabs).toHaveText(["README.md", "index.ts", "file-tree.tsx"])
    await search.fill("")

    // 面包屑：点目录在侧栏里定位到它。
    await page
      .getByRole("navigation", { name: "文件路径" })
      .getByRole("button", { name: "components" })
      .click()
    await expect(row(page, ".file-surface-aside", "components")).toHaveAttribute(
      "aria-expanded",
      "true",
    )

    // 图片在文件标签里预览。
    await row(page, ".file-surface-aside", "logo.png").click()
    await expect(page.locator(".file-image img")).toBeVisible()
    await expect(page.locator(".file-image figcaption")).toHaveText("1 × 1")

    await page.screenshot({ path: "test-results/files-docked.png" })

    // agent 跑完一轮后文件树自动刷新：外部新建的文件出现在树里。
    await page.locator(".right-panel-bar").getByRole("button", { name: "还原面板大小" }).click()
    writeFileSync(join(root, "NEW_FROM_AGENT.md"), "hi\n")
    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toBeVisible()
    await expect(row(page, ".file-surface-aside", "NEW_FROM_AGENT.md")).toBeVisible()

    // 关闭有未保存修改的标签前要确认。
    await page.getByRole("tab", { name: "file-tree.tsx" }).click()
    const second = page.getByRole("textbox", { name: "文件内容 src/components/file-tree.tsx" })
    await second.click()
    await page.keyboard.type("// draft")
    await page.getByRole("button", { name: "关闭 file-tree.tsx" }).click()
    await expect(page.getByRole("dialog").getByText("放弃未保存的修改？")).toBeVisible()
    await page.getByRole("button", { name: "继续编辑" }).click()
    await expect(page.getByRole("tab", { name: "file-tree.tsx" })).toBeVisible()
    await page.getByRole("button", { name: "关闭 file-tree.tsx" }).click()
    await page.getByRole("button", { name: "放弃修改" }).click()
    await expect(page.getByRole("tab", { name: "file-tree.tsx" })).toHaveCount(0)

    // 从当前图片标签关闭其他标签，批量关闭也要保护编辑中的文件。
    await page.getByRole("tab", { name: "index.ts" }).click()
    await editor.click()
    await page.keyboard.type("// keep this")
    const imageTab = page.getByRole("tab", { name: "logo.png" })
    await imageTab.click()
    await imageTab.click({ button: "right" })
    await expect(page.getByRole("dialog")).toContainText("index.ts")
    await page.getByRole("button", { name: "继续编辑" }).click()
    await expect(page.getByRole("tab", { name: "index.ts" })).toBeVisible()
    await imageTab.click({ button: "right" })
    await page.getByRole("button", { name: "放弃修改" }).click()
    await expect(tabs).toHaveText(["logo.png"])
  } finally {
    await app.close()
  }
})

test("closing the window with unsaved file changes asks first", async () => {
  const root = createProject()
  const app = await electron.launch({ args: launchArgs(), env: launchEnv({}) })
  let exited = false
  try {
    const page = await openFilesPanel(app, root)
    await row(page, ".file-surface-aside", "README.md").click()
    await page.getByRole("button", { name: "源码", exact: true }).click()
    await page.getByRole("textbox", { name: "文件内容 README.md" }).click()
    await page.keyboard.type("draft")
    await expect(page.locator(".surface-tab-dirty")).toBeVisible()

    // 系统确认框换成桩：第一次选「继续编辑」，第二次选「放弃修改」。
    await app.evaluate(({ dialog }) => {
      const answers = [1, 0]
      const prompts: string[] = []
      Object.assign(globalThis, { unsavedPrompts: prompts })
      dialog.showMessageBoxSync = ((_window: unknown, options: { message: string }) => {
        prompts.push(options.message)
        return answers.shift() ?? 1
      }) as typeof dialog.showMessageBoxSync
    })
    const prompts = () =>
      app.evaluate(() => (globalThis as unknown as { unsavedPrompts: string[] }).unsavedPrompts)

    // 退出被「继续编辑」取消：窗口、草稿都在，Host 也没有被停掉，会话照常回复。
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect.poll(prompts).toEqual(["放弃未保存的修改？"])
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect(page.locator(".surface-tab-dirty")).toBeVisible()
    await page.locator(".tiptap").click()
    await page.keyboard.type("still there?")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toBeVisible()

    // 再退出时选「放弃修改」：应用退出，磁盘上的文件没被改动。
    const exit = new Promise((resolve) => app.process().once("exit", resolve))
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await exit
    exited = true
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Files demo\n")
  } finally {
    if (!exited) await app.close()
  }
})
