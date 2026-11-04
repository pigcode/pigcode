/**
 * 浏览器侧插件可见的能力：在扩展点上登记的 Panel、Surface、设置页、Command 与工具渲染器，
 * 以及宿主的主题与语言。插件不接触宿主内部对象。
 *
 * 界面只有一种写法：React 组件（ADR-0002）。组件拿到的是宿主的同一个 React，可以用
 * `useLocale`、`useTheme` 等 hook 读取宿主状态；旧的 `render(container)` DOM 渲染函数已删除，
 * 登记时直接抛错。
 */
import type { ComponentType } from "react"

/**
 * 用宿主的 React 渲染插件内容。组件在外壳的 LocaleProvider 之内渲染，所以 `useLocale()` 读到的是
 * 宿主的界面语言；`useTheme()` 读到宿主当前主题。组件不接收 props，需要的状态用 hook 取。
 *
 * 类型上用 `ComponentType` 覆盖 `memo`、`forwardRef`、`lazy`：它们有调用签名，按结构可赋给
 * `FunctionComponent`。宿主在运行时不只看函数，也接受带 `$$typeof` 的对象（见 `isComponent`），
 * 两边的判断保持一致。
 */
export type ClientComponent = ComponentType

/** Panel：左侧栏里的一个区块。宿主画可以收起的标题，内容区是宿主的字体、颜色与间距。 */
export type ClientPanel = {
  /** 在全部 Panel 里唯一；和已有的重名时这次登记不生效，插件页显示冲突。 */
  id: string
  title: string
  /** 小的在前；相同时按 id 排。缺省 0。 */
  order?: number
  Component: ClientComponent
}

/** Surface：Workbench（右侧面板）里的一种标签，列在启动器与「+」菜单的插件组里，打开后是宿主的标签外框。 */
export type ClientSurface = {
  /** 在全部 Surface 里唯一（包括内置的 browser、terminal、files、diff、pr、checkpoint）。 */
  id: string
  title: string
  /** 一句说明，鼠标悬停在启动器条目上时显示。 */
  description?: string
  /** 小的在前；相同时按 id 排。缺省 0。 */
  order?: number
  Component: ClientComponent
}

/**
 * 设置页：设置侧栏「插件设置」组里的一页。宿主画侧栏条目和页面标题，内容区用宿主的字体、颜色与间距；
 * 插件停用时这一页随之移除，正在看它的用户回到通用页。
 * 在 apply 里同步登记：插件更新时新版本同步替换旧版本，正在看这一页的用户留在这一页；await 之后才登记的话，
 * 中间有一刻这一页不存在，用户会回到通用页。
 */
export type ClientSettingsPage = {
  /** 在全部设置页里唯一（包括内置的 general、appearance、agents、schedules、plugins）。 */
  id: string
  /** 侧栏里的名称，也是页面标题。 */
  title: string
  /** 在「插件设置」组里小的在前；相同时按 id 排。缺省 0。 */
  order?: number
  Component: ClientComponent
}

/** 一个扩展点的登记入口；register 返回注销函数。归属由宿主按插件自动填写。 */
export interface ClientContributionApi<T> {
  register(contribution: T): () => void
}

/**
 * Command：命令面板和输入框 `/` 共用的一个具名操作。提供了 `slash` 的命令同时出现在 `/` 建议里，
 * 触发名就是它；命令面板按标题与关键词过滤。
 */
export interface ClientCommand {
  /** 在全部命令里唯一（包括内置的新会话、侧栏、右栏、设置、插件、添加项目）。 */
  id: string
  /** 命令面板里的名称，也是 `/` 建议里的名称。 */
  title: string
  /** 在全部命令里小的在前；相同时按 id 排。缺省 0。 */
  order?: number
  /** 额外的搜索词。 */
  keywords?: readonly string[]
  /** 命令面板里的图标名，见宿主图标表；缺省用通用图标。 */
  icon?: string
  /** 快捷键提示，例如 `Mod+n`；只用于显示，快捷键本身由宿主注册。 */
  shortcut?: string
  /** 现在能不能执行；缺省为能。返回 false 时命令面板和 `/` 都不列出它。 */
  available?: () => boolean
  /** `/` 触发名，例如 `debug` 对应 `/debug`；缺省时只出现在命令面板。 */
  slash?: string
  run(): void | Promise<void>
}

/** 工具的展示族：宿主把各 Agent 的工具名统一成这一套名字，例如 Bash 和 exec_command 都是 `shell`。 */
export type ClientToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "web-fetch"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "task-output"
  | "task-stop"
  | "message"
  | "plan-guidance"
  | "switch-mode"
  | "mcp"
  | "browser"
  | "unknown"

/** 时间线里的一次工具调用。 */
export interface ClientToolCall {
  id: string
  /** Agent 报告的工具名；MCP 工具是 `mcp__<服务>__<工具>`。 */
  name: string
  status: "running" | "completed" | "failed" | "stopped"
  /** 输入与输出的文字形式；还没有时是 undefined。 */
  input: string | undefined
  output: string | undefined
  /** 事件里原样的输入与输出；形状由 Agent 决定，读取时自己校验。 */
  inputValue?: unknown
  outputValue?: unknown
  startedAt?: string | undefined
  endedAt?: string | undefined
  /** 命令的退出码；Agent 不报告时缺省。 */
  exitCode?: number | undefined
}

/**
 * 用宿主的 React 画一次工具调用（ADR-0002）。组件渲染在时间线里，`tool` 是这次调用；
 * 调用的状态、输入或输出变化时宿主用新的 `tool` 重画。
 */
export type ClientToolComponent = ComponentType<{ tool: ClientToolCall }>

/**
 * 工具渲染器：决定一类工具调用在对话时间线里怎么显示。匹配是声明式的：`tools` 和 `families` 至少给一个
 * 非空的，渲染时宿主只比较名字，不运行插件代码。内容是 React 组件，用 `Component` 传。
 */
export type ClientToolRenderer = {
  /** 在全部工具渲染器里唯一（内置的是 `builtin.<族名>`）。 */
  id: string
  /** 小的优先，第一个匹配的生效；相同时按 id 排。缺省 0；内置渲染器是 1000，大于它就排在内置的后面。 */
  order?: number
  /**
   * 工具名。写完整的工具名，或 `mcp__<服务>__<工具>` 里的工具部分：`clock_now` 同时匹配
   * `clock_now` 和 `mcp__pigcode__clock_now`，插件不需要知道各 Agent 加的服务前缀。区分大小写。
   */
  tools?: readonly string[]
  /** 工具族。 */
  families?: readonly ClientToolFamily[]
  Component: ClientToolComponent
}

/** 宿主的当前值与变化通知。 */
export interface ClientObservable<T> {
  get(): T
  subscribe(listener: (value: T) => void): () => void
}

/** 宿主的明暗主题。 */
export type ClientTheme = "light" | "dark"

/** UI 插件拿到的全部能力；只暴露浏览器侧最小面。 */
export interface ClientPluginContext {
  host: { call(method: string, params: unknown): Promise<unknown> }
  /** Panel 扩展点：在左侧栏添加区块。 */
  panels: ClientContributionApi<ClientPanel>
  /** Surface 扩展点：在 Workbench 添加一种标签；注销或插件停用时，已经打开的这种标签随之关闭。 */
  surfaces: ClientContributionApi<ClientSurface>
  /** 设置页扩展点：在设置里添加一页。 */
  settingsPages: ClientContributionApi<ClientSettingsPage>
  /** Command 扩展点：在命令面板和输入框 `/` 里添加一个命令。 */
  commands: ClientContributionApi<ClientCommand>
  /** 工具渲染器扩展点：决定一类工具调用在对话时间线里怎么显示。 */
  toolRenderers: ClientContributionApi<ClientToolRenderer>
  /** 宿主的主题；组件里优先用 ui-primitives 的 `useTheme()`。 */
  theme: ClientObservable<ClientTheme>
  /** 界面语言，例如 `zh-CN`、`en-US`；组件里优先用 ui-primitives 的 `useLocale()`。 */
  locale: ClientObservable<string>
}

/** 插件入口；apply 可以返回清理函数。 */
export type ClientPlugin = (ctx: ClientPluginContext) => void | (() => void)

/** 保留一层薄封装，避免插件作者接触宿主内部对象。 */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin
}
