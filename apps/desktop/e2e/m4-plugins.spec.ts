/** M4 验收：安装/启用/停用第三方 Agent、UI、Capability 插件。 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, expect, test, type Page } from "@playwright/test"
import {
  addProject,
  backFromSettings,
  installPlugin,
  launchArgs,
  launchEnv,
  openPluginsSettings,
} from "./projects"

/** 仓库里的脚手架脚本：生成一个 UI 插件用到真实的模板，而不是复制的样例。 */
const CREATE_PLUGIN = fileURLToPath(new URL("../../../scripts/create-plugin.ts", import.meta.url))

/** 插件页在「设置 → 插件」里。 */
async function openPlugins(page: Page, manage = false): Promise<void> {
  await openPluginsSettings(page, manage)
}
/** 插件页上某个插件的卡片，按包名定位。 */
const pluginTile = (page: Page, name: string) => page.locator(`.market-tile[data-plugin='${name}']`)
/** 从设置插件页回到会话：先退出设置，再点侧栏里的会话。 */
async function backToChat(page: Page): Promise<void> {
  await backFromSettings(page)
  await page.locator(".sidebar .sess").first().click()
}

test("installs, enables, and disables plugins without restart", async () => {
  // 每次从干净的项目目录开始，避免上一次失败残留影响结果。
  const projectRoot = "/tmp/pigcode-m4-e2e"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const app = await electron.launch({ args: launchArgs(), env: { ...env, PIGCODE_AGENT: "echo" } })
  const page = await app.firstWindow()
  // 安装 Agent 插件
  await addProject(app, page, projectRoot)
  await openPlugins(page)
  await expect(
    page.locator(".sidebar").getByRole("button", { name: "插件", exact: true }),
  ).toHaveAttribute("aria-current", "page")
  const agent = new URL("../../../examples/agent-echo", import.meta.url).pathname
  await installPlugin(page, agent)
  const echo = pluginTile(page, "pigcode-agent-echo")
  await expect(echo).toBeVisible()
  await expect(echo.getByRole("switch")).toBeChecked()

  // 退回工作区后新建会话，默认 agent 由 PIGCODE_AGENT=echo 强制。
  await backFromSettings(page)
  await page.getByRole("button", { name: "新会话" }).first().click()
  // 线程创建是异步 RPC；等 composer 可编辑后再输入。
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello echo")
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: "hello echo" })).toBeVisible()
  // echo agent 把输入原样回传，确认插件提供的 agent 真的接管了这次 run。
  await expect(page.locator(".msg-ai").filter({ hasText: "hello echo" })).toBeVisible()

  // 安装 UI 插件：它的 Panel 出现在侧栏，Surface 出现在右侧面板的「+」菜单里，设置页出现在设置侧栏里。
  const backToApp = () => page.getByRole("button", { name: "返回应用" }).first().click()
  await openPlugins(page)
  const ui = new URL("../../../examples/ui-debug-panel", import.meta.url).pathname
  await installPlugin(page, ui)
  const debug = pluginTile(page, "pigcode-ui-debug-panel")
  await expect(debug.getByRole("switch")).toBeChecked()
  const debugPanel = page.locator(".plugin-panel-head").filter({ hasText: "Debug Panel" })
  await expect(debugPanel).toBeVisible()

  // 卡片上的「打开」去插件自己的设置页。设置页列在内置页后面的「插件设置」组里；宿主画页面标题，
  // 插件画下面的内容。设置里的搜索也搜得到它。
  const sidebar = page.locator(".sidebar")
  const settingsNav = sidebar.locator(".nav-item:not(.back)")
  const debugSettings = sidebar.getByRole("button", { name: "Debug Settings", exact: true })
  const debugSettingsTitle = page.getByRole("heading", { level: 1, name: "Debug Settings" })
  const openDebugSettings = debug.getByRole("button", {
    name: "打开 pigcode-ui-debug-panel 的设置",
  })
  await openDebugSettings.click()
  await expect(debugSettingsTitle).toBeVisible()
  await expect(debugSettings).toHaveAttribute("aria-current", "page")
  await expect(settingsNav).toHaveText([
    "通用",
    "外观",
    "手机端",
    "远程主机",
    "Agent",
    "插件",
    "守护进程、中继与识别色",
    "Debug Settings",
  ])
  await expect(sidebar.locator(".side-group")).toHaveText(["应用与连接", "插件设置"])
  await expect(
    page
      .locator("[data-plugin-content='debug-settings']")
      .getByRole("switch", { name: "详细日志" }),
  ).toBeVisible()
  await sidebar.getByRole("button", { name: "通用", exact: true }).click()
  await expect(debugSettingsTitle).toBeHidden()
  const searchTrigger = sidebar.getByRole("button", { name: "搜索设置", exact: true })
  await expect(searchTrigger).toHaveCSS("height", "28px")
  await searchTrigger.click()
  const settingsSearch = page.getByRole("dialog", { name: "搜索设置" })
  const search = settingsSearch.getByRole("combobox", { name: "搜索设置" })
  await expect(search).toHaveCSS("height", "28px")
  await expect(search).toBeFocused()
  await search.fill("debug")
  await settingsSearch.getByRole("option", { name: "Debug Settings" }).click()
  await expect(settingsSearch).toBeHidden()
  await expect(debugSettingsTitle).toBeVisible()
  await expect(settingsNav).toHaveCount(8)
  await backToApp()
  await expect(debugPanel).toBeVisible()

  // 插件命令在命令面板和输入框 `/` 里都能执行：面板里的计数由同一条命令递增。
  const debugRunCount = page
    .locator("[data-plugin-content='debug-panel']")
    .getByText(/示例命令已执行/)
  await expect(debugRunCount).toHaveCount(0)
  await page.keyboard.press("ControlOrMeta+k")
  await page.locator(".palette input").fill("示例命令")
  await page.getByRole("option", { name: /运行示例命令/ }).click()
  await expect(debugRunCount).toHaveText("示例命令已执行 1 次")
  await page.locator(".tiptap").click()
  await page.keyboard.type("/debug")
  await expect(page.getByRole("listbox", { name: "命令" })).toContainText("/debug")
  await page.keyboard.press("Enter")
  await expect(debugRunCount).toHaveText("示例命令已执行 2 次")

  // Panel 由插件的 React 组件渲染：宿主的 ListRow、Badge、Switch，hook 读到宿主的主题与语言。
  const panel = page.locator("[data-plugin-content='debug-panel']")
  await expect(panel.locator(".list-row-title").first()).toHaveText("主题")
  await expect(panel.getByRole("switch", { name: "详细日志" })).toBeVisible()
  await panel.getByRole("switch", { name: "详细日志" }).click()
  await expect(panel.getByRole("switch", { name: "详细日志" })).toBeChecked()
  // useTheme() 和宿主的 data-theme 一致，useLocale() 就是宿主的界面语言。
  const hostLocale = await page.locator("html").getAttribute("lang")
  const hostTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "light")
  await expect(panel.getByText(hostTheme, { exact: true })).toBeVisible()
  await expect(panel.getByText(hostLocale ?? "", { exact: true })).toBeVisible()

  await page.locator(".panel-top").getByRole("button", { name: "显示或隐藏右侧面板" }).click()
  const tabs = page.locator(".right-panel").getByRole("tab")
  const addSurface = page.getByRole("button", { name: "添加面板" })
  await addSurface.click()
  await page.getByRole("menuitem", { name: /终端/ }).click()
  await expect(tabs).toHaveText(["终端 1"])
  await addSurface.click()
  await page.getByRole("menuitem", { name: "Debug Inspector" }).click()
  await expect(tabs).toHaveText(["终端 1", "Debug Inspector"])
  await expect(page.getByRole("tab", { name: "Debug Inspector" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.locator("[data-plugin-content='debug-inspector']")).toBeVisible()
  // Surface 和设置页一样是组装好的宿主分组：读项目按钮调 Host 的 project.list，结果显示成设置行。
  const inspector = page.locator("[data-plugin-content='debug-inspector']")
  await expect(inspector.locator(".section-head h2").first()).toHaveText("宿主")
  await expect(inspector.locator(".empty-state").first()).toContainText("还没有项目")
  await inspector.getByRole("button", { name: "读取项目" }).click()
  // 分组下面那行是这一组的说明，之后才是读到的项目。
  await expect(inspector.locator(".list-row-title")).toHaveText([
    "主题",
    "语言",
    "通过 ctx.host.call 调用 Host 的 project.list。",
    "pigcode-m4-e2e",
  ])
  await expect(inspector.locator(".empty-state")).toHaveCount(0)

  // 设置记得上次看的页：再打开设置时回到 Debug 设置页。从命令面板打开插件页，设置里选中的仍是
  // Debug 设置页，就在这时停用它。
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await expect(debugSettingsTitle).toBeVisible()
  await page.keyboard.press("ControlOrMeta+k")
  await page.locator(".palette input").fill("插件")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { level: 1, name: "插件市场" })).toBeVisible()
  await page.getByRole("button", { name: "插件管理", exact: true }).click()

  // 停用后 Panel 和设置页消失（卡片上的「打开」也跟着没了），打开着的 Surface 标签关闭，
  // 当前标签改选终端，「+」菜单里也不再有它。
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).not.toBeChecked()
  await expect(debugPanel).toBeHidden()
  await expect(openDebugSettings).toHaveCount(0)
  // 后退跳过已经移除的 Debug 设置页，直接回到会话，不会停在空白的设置页上。
  await page.getByRole("button", { name: "后退" }).click()
  await expect(page.locator(".tiptap")).toBeVisible()
  await expect(tabs).toHaveText(["终端 1"])
  await expect(page.getByRole("tab", { name: "终端 1" })).toHaveAttribute("aria-selected", "true")
  await expect(debugPanel).toHaveCount(0)
  // 命令也随插件停用：命令面板和输入框 `/` 里都不再有它。改选的终端拿着焦点，Windows/Linux 上
  // Ctrl+K 归终端里的 shell；先把焦点放回输入框（输入框里 Ctrl+K 照样打开命令面板）。
  await page.locator(".tiptap").click()
  await page.keyboard.press("ControlOrMeta+k")
  await page.locator(".palette input").fill("示例命令")
  await expect(page.locator(".palette")).toContainText("没找到")
  await page.keyboard.press("Escape")
  await page.locator(".tiptap").click()
  await page.keyboard.type("/debug")
  await expect(page.getByRole("listbox", { name: "命令" })).toContainText("没找到命令")
  await page.keyboard.press("Escape")
  // 没有匹配时触发词留在输入框里，像 @ 一样要自己删掉。
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
  await expect(page.locator(".tiptap")).toHaveText("")
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: /终端/ })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Debug Inspector" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // 选中的 Debug 设置页已经移除：再次打开设置时直接落到当前可用的插件页，侧栏不再保留 Debug 设置项。
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "插件市场", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "插件", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(sidebar.locator(".side-group")).toHaveText(["应用与连接"])
  await expect(debugSettings).toHaveCount(0)

  // 重新启用：Panel、设置页与 Surface 回来。
  await backToApp()
  await openPlugins(page, true)
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).toBeChecked()
  await expect(debugPanel).toBeVisible()
  await expect(openDebugSettings).toBeVisible()
  await backToChat(page)
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: "Debug Inspector" })).toBeVisible()
  await page.keyboard.press("Escape")
  await openPlugins(page)

  // Capability 插件没有可见 UI，用卡片状态验证启停热生效；详情里是包名与类型。
  const capabilityPlugin = new URL("../../../examples/capability-session-info", import.meta.url)
    .pathname
  await installPlugin(page, capabilityPlugin)
  const capabilityItem = pluginTile(page, "pigcode-capability-session-info")
  await expect(capabilityItem.getByRole("switch")).toBeChecked()
  await capabilityItem.getByRole("switch").click()
  await expect(capabilityItem.getByRole("switch")).not.toBeChecked()
  await expect(capabilityItem).toHaveAttribute("data-enabled", "false")
  await capabilityItem.locator(".market-tile-main").click()
  const details = page.getByRole("dialog", { name: "pigcode-capability-session-info" })
  await expect(details.locator(".ext-facts")).toContainText("能力")
  await expect(details.locator(".ext-facts")).toContainText("pigcode-capability-session-info")

  await app.close()
})

test("a plugin's contributions on all five extension points come and go with it", async () => {
  const projectRoot = "/tmp/pigcode-m4-e2e-renderers"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ PIGCODE_FAKE_STEP_MS: "40" }),
  })
  const page = await app.firstWindow()
  await addProject(app, page, projectRoot)

  await openPlugins(page)
  // ui-debug-panel 在五个扩展点上都登记了内容；capability-clock 是带界面代码的 Capability 插件。
  await installPlugin(page, new URL("../../../examples/ui-debug-panel", import.meta.url).pathname)
  await installPlugin(page, new URL("../../../examples/capability-clock", import.meta.url).pathname)
  const debug = pluginTile(page, "pigcode-ui-debug-panel")
  const clock = pluginTile(page, "pigcode-capability-clock")
  await expect(debug.getByRole("switch")).toBeChecked()
  await expect(clock.getByRole("switch")).toBeChecked()

  // fake agent 调用样例插件的工具：clock_now 带 MCP 前缀和不带各一次，还有 debug_probe。
  await backFromSettings(page)
  await page.getByRole("button", { name: "新会话" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.locator(".tiptap").click()
  await page.keyboard.type("renderers")
  await page.keyboard.press("Enter")
  const turn = page.locator(".turn").last()
  await expect(turn).toHaveAttribute("data-status", "completed")

  const debugPanel = page.locator(".plugin-panel-head").filter({ hasText: "Debug Panel" })
  // 插件的设置页登记着的时候，它的卡片上有「打开」。
  const debugSettings = debug.getByRole("button", { name: "打开 pigcode-ui-debug-panel 的设置" })
  const addSurface = page.getByRole("button", { name: "添加面板" })
  const inspectorItem = page.getByRole("menuitem", { name: "Debug Inspector" })
  const commandOption = page.getByRole("option", { name: /运行示例命令/ })
  const probeRow = turn.locator("[data-plugin-content='debug-probe']")
  const clockRows = turn.locator("[data-plugin-content='clock-now']")
  const genericProbe = turn.getByRole("button", { name: /^Debug probe/ })
  const genericClock = turn.getByRole("button", { name: /^Clock now/ })
  const mcpClock = turn.getByRole("button", { name: /^MCP.*Clock now/ })
  /** 这一轮结束后工作区是折叠的；回到会话时重新展开。 */
  const showWork = async () => {
    const toggle = turn.locator(".work-toggle")
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
  }
  await page.locator(".panel-top").getByRole("button", { name: "显示或隐藏右侧面板" }).click()

  // 启用：Panel、Surface、Command、工具渲染器和设置页都出现。
  await showWork()
  await expect(debugPanel).toBeVisible()
  await addSurface.click()
  await expect(inspectorItem).toBeVisible()
  await page.keyboard.press("Escape")
  await page.locator(".tiptap").click()
  await page.keyboard.press("ControlOrMeta+k")
  await page.locator(".palette input").fill("示例命令")
  await expect(commandOption).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(probeRow).toHaveText("调试探针 · completed")
  await expect(genericProbe).toHaveCount(0)
  // 两种名字的 clock_now 都用插件的渲染器，内置的 MCP 行和通用行都不出现。
  await expect(clockRows).toHaveCount(2)
  await expect(clockRows.first()).toContainText("当前时间")
  await expect(clockRows.last()).toContainText("当前时间")
  await expect(mcpClock).toHaveCount(0)
  await expect(genericClock).toHaveCount(0)
  await openPlugins(page, true)
  await expect(debugSettings).toBeVisible()

  // 停用：五处都消失，时间线回到内置的 MCP 行和通用行。
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).not.toBeChecked()
  await clock.getByRole("switch").click()
  await expect(clock.getByRole("switch")).not.toBeChecked()
  await expect(debugSettings).toHaveCount(0)
  await expect(debugPanel).toBeHidden()
  await backToChat(page)
  await showWork()
  await expect(probeRow).toHaveCount(0)
  await expect(clockRows).toHaveCount(0)
  await expect(genericProbe).toBeVisible()
  await expect(genericClock).toBeVisible()
  await expect(mcpClock).toBeVisible()
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: /终端/ })).toBeVisible()
  await expect(inspectorItem).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.locator(".tiptap").click()
  await page.keyboard.press("ControlOrMeta+k")
  await page.locator(".palette input").fill("示例命令")
  await expect(page.locator(".palette")).toContainText("没找到")
  await page.keyboard.press("Escape")

  // 重新启用：渲染器回来，已经在时间线里的调用换回插件的显示。
  await openPlugins(page, true)
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).toBeChecked()
  await clock.getByRole("switch").click()
  await expect(clock.getByRole("switch")).toBeChecked()
  await expect(debugSettings).toBeVisible()
  await backToChat(page)
  await showWork()
  await expect(probeRow).toBeVisible()
  await expect(clockRows).toHaveCount(2)
  await expect(genericClock).toHaveCount(0)
  await page.locator(".tiptap").click()
  await page.keyboard.press("ControlOrMeta+k")
  await page.locator(".palette input").fill("示例命令")
  await expect(commandOption).toBeVisible()
  await page.keyboard.press("Escape")

  // 后面的用例不需要 clock 样例，只留一个停用的记录，和其余样例一样。
  await openPlugins(page, true)
  await clock.getByRole("switch").click()
  await expect(clock.getByRole("switch")).not.toBeChecked()

  await app.close()
})

test("a generated UI plugin is a React plugin and runs right after generating", async () => {
  const projectRoot = "/tmp/pigcode-m4-e2e-generated"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  // 真的跑一次脚手架，不只是读模板：生成出来的目录要能直接安装、运行。
  const generated = join(mkdtempSync(join(tmpdir(), "pigcode-generated-ui-")), "demo")
  execFileSync(process.execPath, [CREATE_PLUGIN, generated, "ui", "demo"], { stdio: "pipe" })

  const app = await electron.launch({ args: launchArgs(), env: launchEnv({}) })
  const page = await app.firstWindow()
  await addProject(app, page, projectRoot)

  await openPlugins(page)
  await installPlugin(page, generated)
  await expect(pluginTile(page, "pigcode-ui-demo").getByRole("switch")).toBeChecked()

  // Panel 由生成的 React 组件渲染：ui-primitives 的 ListRow、Badge 与 Button，hook 读到宿主的主题与语言。
  const panel = page.locator("[data-plugin-content='demo-panel']")
  await expect(panel.locator(".list-row-title")).toHaveText(["主题", "语言"])
  await expect(panel.getByText("来自 pigcode-ui-demo 的问候")).toBeVisible()
  const hostTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "light")
  await expect(panel.getByText(hostTheme, { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "点了 0 次" }).click()
  await expect(panel.getByRole("button", { name: "点了 1 次" })).toBeVisible()

  // 生成的 Surface 与设置页也由组件渲染。
  await backFromSettings(page)
  await page.getByRole("button", { name: "新会话" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.locator(".panel-top").getByRole("button", { name: "显示或隐藏右侧面板" }).click()
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: "Demo" }).click()
  await expect(page.locator("[data-plugin-content='demo-surface']")).toBeVisible()
  await page.getByRole("button", { name: "设置", exact: true }).click()
  // 侧栏里 Panel 的标题也叫 Demo，取设置导航里的那一项。
  await page.locator(".sidebar .nav-item").filter({ hasText: "Demo" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Demo" })).toBeVisible()
  await expect(
    page.locator("[data-plugin-content='demo-settings']").getByRole("switch", { name: "详细日志" }),
  ).toBeVisible()

  await app.close()
})

test("a plugin written with React renders the host's ui-primitives and reads the host context", async () => {
  const projectRoot = "/tmp/pigcode-m4-e2e-react"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({ args: launchArgs(), env: launchEnv({}) })
  const page = await app.firstWindow()
  await addProject(app, page, projectRoot)

  // 安装用 React 写的 UI 插件（TSX 入口在安装时编译）。
  await openPlugins(page)
  const ui = new URL("../../../examples/ui-react-panel", import.meta.url).pathname
  await installPlugin(page, ui)
  await expect(pluginTile(page, "pigcode-ui-react-panel").getByRole("switch")).toBeChecked()

  // Panel 由插件的 React 组件渲染：ui-primitives 的 Button 与 ListRow，hook 读到宿主的主题与语言。
  const panel = page.locator("[data-plugin-content='react-panel']")
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("button", { name: "点我加一" })).toBeVisible()
  await expect(panel.getByText("主题", { exact: true })).toBeVisible()
  await expect(panel.getByText("语言", { exact: true })).toBeVisible()
  // useLocale() 读到的就是宿主的界面语言；useTheme() 和宿主的 data-theme 一致。
  const hostLocale = await page.locator("html").getAttribute("lang")
  const hostTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "light")
  await expect(panel.getByText(hostTheme, { exact: true })).toBeVisible()
  await expect(panel.getByText(hostLocale ?? "", { exact: true })).toBeVisible()

  // useState 用的是宿主的 React：点击后组件自己重画，计数增加。
  await panel.getByRole("button", { name: "点我加一" }).click()
  await expect(panel.getByText("点了 1 次")).toBeVisible()
  await panel.getByRole("button", { name: "点我加一" }).click()
  await expect(panel.getByText("点了 2 次")).toBeVisible()

  // Surface 用同一个 React 组件：在右侧面板里打开，ui-primitives 的组件照常显示。
  // 右侧面板要先有会话才能切换。
  await backFromSettings(page)
  await page.getByRole("button", { name: "新会话" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.locator(".panel-top").getByRole("button", { name: "显示或隐藏右侧面板" }).click()
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: "React Inspector" }).click()
  const surface = page.locator("[data-plugin-content='react-inspector']")
  await expect(surface).toBeVisible()
  await expect(surface.getByRole("button", { name: "点我加一" })).toBeVisible()

  // 插件的设置页同样由组件渲染。
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "React Settings", exact: true })
    .click()
  await expect(page.getByRole("heading", { level: 1, name: "React Settings" })).toBeVisible()
  await expect(
    page
      .locator("[data-plugin-content='react-settings']")
      .getByRole("button", { name: "点我加一" }),
  ).toBeVisible()

  await app.close()
})
