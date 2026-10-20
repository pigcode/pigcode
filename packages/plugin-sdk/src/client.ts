/** 浏览器侧插件可见的最小能力；核心给更多能力时通过可选字段扩展。 */
export interface ClientPanel {
  id: string
  title: string
  render(container: HTMLElement): void
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

/** UI 插件拿到的全部能力；只暴露浏览器侧最小面。 */
export interface ClientPluginContext {
  slots: ClientSlotApi
  host: { call(method: string, params: unknown): Promise<unknown> }
  /** 兼容 M0-A 的 DOM 面板式示例插件。 */
  registerPanel(panel: ClientPanel): () => void
}

/** 插件入口；apply 可以返回清理函数。 */
export type ClientPlugin = (ctx: ClientPluginContext) => void | (() => void)

/** 保留一层薄封装，避免插件作者接触宿主内部对象。 */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin
}
