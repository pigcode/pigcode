/**
 * 浏览器侧插件可见的能力：DOM 面板与右栏标签、和宿主一致的界面组件（pg-* 样式）、
 * 宿主的主题与语言。插件不依赖 React，也不接触宿主内部对象。
 */

/** 把内容画进容器；可以返回清理函数，面板移除或重画前调用。 */
export type ClientRender = (container: HTMLElement) => void | (() => void)

/** 侧栏里的一个 DOM 面板：宿主画标题栏，内容区用宿主的字体、颜色与间距。 */
export interface ClientPanel {
  id: string
  title: string
  render: ClientRender
}

/** 右栏里的一种插件标签：出现在右栏的启动器与「+」菜单里，打开后是宿主的标签外框。 */
export interface ClientSurface {
  id: string
  title: string
  /** 一句说明，鼠标悬停在启动器条目上时显示。 */
  description?: string
  render: ClientRender
}

/** client bundle 可以注册的 slot 条目；不依赖 React 类型。 */
export interface ClientSlotEntry {
  id: string
  order?: number
  /** 参数声明为 never，使 React 侧带 props 的条目也能安全赋给该 facade。 */
  render(props: never): unknown
}

/** 受限的 slot API；由 client-runtime 的 SlotRegistry 实现。 */
export interface ClientSlotApi {
  register(name: string, entry: ClientSlotEntry): () => void
}

/** 宿主的当前值与变化通知。 */
export interface ClientObservable<T> {
  get(): T
  subscribe(listener: (value: T) => void): () => void
}

/** 宿主的明暗主题。 */
export type ClientTheme = "light" | "dark"

/** 按钮的样式。 */
export type ClientButtonVariant = "primary" | "secondary" | "ghost" | "danger"

/** 徽标的色调。 */
export type ClientTone = "neutral" | "accent" | "success" | "warning" | "danger"

/**
 * 和宿主界面一致的 DOM 组件：返回普通元素，由插件自己放进容器。样式来自宿主的 pg-* 类，
 * 跟随宿主的主题、字号与强调色；插件自己的样式可以用文档里列出的 --pg-* 变量。
 */
export interface ClientUiKit {
  /** 一组内容：可选的标题与说明，下面是 children。 */
  section(options: { title?: string; description?: string; children?: Node[] }): HTMLElement
  /** 设置行：左边标题与说明，右边是控件。 */
  row(options: { title: string; description?: string; control?: Node }): HTMLElement
  button(options: {
    label: string
    variant?: ClientButtonVariant
    disabled?: boolean
    onClick?: () => void
  }): HTMLButtonElement
  input(options: {
    label: string
    value?: string
    placeholder?: string
    onChange?: (value: string) => void
  }): HTMLInputElement
  /** 开关（role="switch"）。 */
  toggle(options: {
    label: string
    checked: boolean
    onChange?: (checked: boolean) => void
  }): HTMLButtonElement
  badge(label: string, tone?: ClientTone): HTMLElement
  text(
    content: string,
    options?: { tone?: "default" | "muted" | "faint"; size?: "sm" | "md" },
  ): HTMLElement
  /** 等宽的代码块。 */
  code(content: string): HTMLElement
  /** 一列可点的条目：标题、说明与右侧的补充信息。 */
  list(
    items: ReadonlyArray<{
      title: string
      description?: string
      meta?: string
      onClick?: () => void
    }>,
  ): HTMLElement
  /** 空状态：标题与一句说明。 */
  empty(options: { title: string; description?: string }): HTMLElement
}

/** UI 插件拿到的全部能力；只暴露浏览器侧最小面。 */
export interface ClientPluginContext {
  slots: ClientSlotApi
  host: { call(method: string, params: unknown): Promise<unknown> }
  /** 在侧栏添加一个面板；返回注销函数。 */
  registerPanel(panel: ClientPanel): () => void
  /** 在右栏添加一种标签；返回注销函数，已经打开的标签随之关闭。 */
  registerSurface(surface: ClientSurface): () => void
  ui: ClientUiKit
  theme: ClientObservable<ClientTheme>
  /** 界面语言，例如 `zh-CN`、`en-US`。 */
  locale: ClientObservable<string>
}

/** 插件入口；apply 可以返回清理函数。 */
export type ClientPlugin = (ctx: ClientPluginContext) => void | (() => void)

/** 保留一层薄封装，避免插件作者接触宿主内部对象。 */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin
}
