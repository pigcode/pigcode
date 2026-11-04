/** M4 验收：安装/启用/停用第三方 Agent、UI、Capability 插件。 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, expect, test } from "@playwright/test"
import { addProject, installPlugin, launchEnv } from "./projects"

/** 仓库里的脚手架脚本：生成一个 UI 插件用到真实的模板，而不是复制的样例。 */
const CREATE_PLUGIN = fileURLToPath(new URL("../../../scripts/create-plugin.ts", import.meta.url))

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
  const app = await electron.launch({ args: ["."], env: { ...env, PIGCODE_AGENT: "echo" } })
  const page = await app.firstWindow()
  // 安装 Agent 插件
  await addProject(app, page, projectRoot)
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const agent = new URL("../../../examples/agent-echo", import.meta.url).pathname
  await installPlugin(page, agent)
  const echo = page.locator(".ext-item").filter({ hasText: "pigcode-agent-echo" })
  await expect(echo).toBeVisible()
  await expect(echo.getByRole("switch")).toBeChecked()
  // 设置页的侧栏和内容区各有一个返回入口，取侧栏那个。
  await page.getByRole("button", { name: "返回应用" }).first().click()

  // 新建会话，默认 agent 由 PIGCODE_AGENT=echo 强制
  await page.getByRole("button", { name: "新会话" }).first().click()
  // 线程创建是异步 RPC；等 composer 可编辑后再输入。
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.getByRole("textbox").fill("hello echo")
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: "hello echo" })).toBeVisible()
  // echo agent 把输入原样回传，确认插件提供的 agent 真的接管了这次 run。
  await expect(page.locator(".msg-ai").filter({ hasText: "hello echo" })).toBeVisible()

  // 安装 UI 插件：它的 Panel 出现在侧栏，Surface 出现在右侧面板的「+」菜单里，设置页出现在设置侧栏里。
  const openPlugins = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "插件", exact: true }).first().click()
  }
  const backToApp = () => page.getByRole("button", { name: "返回应用" }).first().click()
  await openPlugins()
  const ui = new URL("../../../examples/ui-debug-panel", import.meta.url).pathname
  await installPlugin(page, ui)
  const debug = page.locator(".ext-item").filter({ hasText: "pigcode-ui-debug-panel" })
  await expect(debug.getByRole("switch")).toBeChecked()
  const debugPanel = page.locator(".plugin-panel-head").filter({ hasText: "Debug Panel" })
  await expect(debugPanel).toBeVisible()

  // 设置页列在内置页后面的「插件设置」组里；宿主画页面标题，插件画下面的内容。设置里的搜索也搜得到它。
  const sidebar = page.locator(".sidebar")
  const settingsNav = sidebar.locator(".nav-item:not(.back)")
  const debugSettings = sidebar.getByRole("button", { name: "Debug Settings", exact: true })
  const debugSettingsTitle = page.getByRole("heading", { level: 1, name: "Debug Settings" })
  await expect(settingsNav).toHaveText([
    "通用",
    "外观",
    "Agent",
    "定时任务",
    "插件",
    "Debug Settings",
  ])
  await expect(sidebar.locator(".side-group")).toHaveText(["设置", "插件设置"])
  await debugSettings.click()
  await expect(debugSettingsTitle).toBeVisible()
  await expect(
    page
      .locator("[data-plugin-content='debug-settings']")
      .getByRole("switch", { name: "详细日志" }),
  ).toBeVisible()
  const search = page.getByPlaceholder("搜索设置")
  await search.fill("debug")
  await expect(settingsNav).toHaveText(["Debug Settings"])
  await search.fill("")
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

  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
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
  await expect(page.getByRole("heading", { level: 1, name: "插件管理" })).toBeVisible()

  // 停用后 Panel 和设置页消失，打开着的 Surface 标签关闭，当前标签改选终端，「+」菜单里也不再有它。
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).not.toBeChecked()
  await expect(debugPanel).toBeHidden()
  await expect(debugSettings).toHaveCount(0)
  await expect(sidebar.locator(".side-group")).toHaveText(["设置"])
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
  await expect(page.locator(".palette")).toContainText("没有匹配结果")
  await page.keyboard.press("Escape")
  await page.locator(".tiptap").click()
  await page.keyboard.type("/debug")
  await expect(page.getByRole("listbox", { name: "命令" })).toContainText("没有匹配的命令")
  await page.keyboard.press("Escape")
  // 没有匹配时触发词留在输入框里，像 @ 一样要自己删掉。
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
  await expect(page.locator(".tiptap")).toHaveText("")
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: /终端/ })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Debug Inspector" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // 选中的 Debug 设置页已经没有了：再打开设置时是通用页，不是空白页。
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "通用设置" })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "通用", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )

  // 重新启用：Panel、设置页与 Surface 回来。
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).toBeChecked()
  await expect(debugPanel).toBeVisible()
  await expect(debugSettings).toBeVisible()
  await backToApp()
  await addSurface.click()
  await expect(page.getByRole("menuitem", { name: "Debug Inspector" })).toBeVisible()
  await page.keyboard.press("Escape")
  await openPlugins()

  // Capability 插件没有可见 UI，用列表状态验证启停热生效；详情里是包名与类型。
  const capabilityPlugin = new URL("../../../examples/capability-session-info", import.meta.url)
    .pathname
  await installPlugin(page, capabilityPlugin)
  const capabilityItem = page
    .locator(".ext-item")
    .filter({ hasText: "pigcode-capability-session-info" })
  await expect(capabilityItem.getByRole("switch")).toBeChecked()
  await capabilityItem.getByRole("switch").click()
  await expect(capabilityItem.getByRole("switch")).not.toBeChecked()
  await expect(capabilityItem).toContainText("已停用")
  await capabilityItem.locator(".ext-row-main").click()
  await expect(capabilityItem.locator(".ext-facts")).toContainText("能力")

  await app.close()
})

test("a plugin's contributions on all five extension points come and go with it", async () => {
  const projectRoot = "/tmp/pigcode-m4-e2e-renderers"
  rmSync(projectRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  const app = await electron.launch({
    args: ["."],
    env: launchEnv({ PIGCODE_FAKE_STEP_MS: "40" }),
  })
  const page = await app.firstWindow()
  await addProject(app, page, projectRoot)

  const openPlugins = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "插件", exact: true }).first().click()
  }
  const backToApp = () => page.getByRole("button", { name: "返回应用" }).first().click()
  await openPlugins()
  // ui-debug-panel 在五个扩展点上都登记了内容；capability-clock 是带界面代码的 Capability 插件。
  await installPlugin(page, new URL("../../../examples/ui-debug-panel", import.meta.url).pathname)
  await installPlugin(page, new URL("../../../examples/capability-clock", import.meta.url).pathname)
  const debug = page.locator(".ext-item").filter({ hasText: "pigcode-ui-debug-panel" })
  const clock = page.locator(".ext-item").filter({ hasText: "pigcode-capability-clock" })
  await expect(debug.getByRole("switch")).toBeChecked()
  await expect(clock.getByRole("switch")).toBeChecked()
  await backToApp()

  // fake agent 调用样例插件的工具：clock_now 带 MCP 前缀和不带各一次，还有 debug_probe。
  await page.getByRole("button", { name: "新会话" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.locator(".tiptap").click()
  await page.keyboard.type("renderers")
  await page.keyboard.press("Enter")
  const turn = page.locator(".turn").last()
  await expect(turn).toHaveAttribute("data-status", "completed")

  const debugPanel = page.locator(".plugin-panel-head").filter({ hasText: "Debug Panel" })
  const debugSettings = page
    .locator(".sidebar")
    .getByRole("button", { name: "Debug Settings", exact: true })
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
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()

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
  await openPlugins()
  await expect(debugSettings).toBeVisible()

  // 停用：五处都消失，时间线回到内置的 MCP 行和通用行。
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).not.toBeChecked()
  await clock.getByRole("switch").click()
  await expect(clock.getByRole("switch")).not.toBeChecked()
  await expect(debugSettings).toHaveCount(0)
  await expect(debugPanel).toBeHidden()
  await backToApp()
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
  await expect(page.locator(".palette")).toContainText("没有匹配结果")
  await page.keyboard.press("Escape")

  // 重新启用：渲染器回来，已经在时间线里的调用换回插件的显示。
  await openPlugins()
  await debug.getByRole("switch").click()
  await expect(debug.getByRole("switch")).toBeChecked()
  await clock.getByRole("switch").click()
  await expect(clock.getByRole("switch")).toBeChecked()
  await expect(debugSettings).toBeVisible()
  await backToApp()
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
  await openPlugins()
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

  const app = await electron.launch({ args: ["."], env: launchEnv({}) })
  const page = await app.firstWindow()
  await addProject(app, page, projectRoot)

  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  await installPlugin(page, generated)
  const item = page.locator(".ext-item").filter({ hasText: "pigcode-ui-demo" })
  await expect(item.getByRole("switch")).toBeChecked()
  await page.getByRole("button", { name: "返回应用" }).first().click()

  // Panel 由生成的 React 组件渲染：ui-primitives 的 ListRow、Badge 与 Button，hook 读到宿主的主题与语言。
  const panel = page.locator("[data-plugin-content='demo-panel']")
  await expect(panel.locator(".list-row-title")).toHaveText(["主题", "语言"])
  await expect(panel.getByText("来自 pigcode-ui-demo 的问候")).toBeVisible()
  const hostTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "light")
  await expect(panel.getByText(hostTheme, { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "点了 0 次" }).click()
  await expect(panel.getByRole("button", { name: "点了 1 次" })).toBeVisible()

  // 生成的 Surface 与设置页也由组件渲染。
  await page.getByRole("button", { name: "新会话" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
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
  const app = await electron.launch({ args: ["."], env: launchEnv({}) })
  const page = await app.firstWindow()
  await addProject(app, page, projectRoot)

  // 安装用 React 写的 UI 插件（TSX 入口在安装时编译）。
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  const ui = new URL("../../../examples/ui-react-panel", import.meta.url).pathname
  await installPlugin(page, ui)
  const item = page.locator(".ext-item").filter({ hasText: "pigcode-ui-react-panel" })
  await expect(item.getByRole("switch")).toBeChecked()
  await page.getByRole("button", { name: "返回应用" }).first().click()

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
  await page.getByRole("button", { name: "新会话" }).first().click()
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
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
