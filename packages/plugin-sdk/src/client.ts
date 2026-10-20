/** 浏览器侧插件的最小 facade；M0-A 只支持注册调试面板。 */
export interface ClientPanel {
  id: string
  title: string
  render(container: HTMLElement): void
}

export interface ClientPluginContext {
  registerPanel(panel: ClientPanel): () => void
}

export type ClientPlugin = (ctx: ClientPluginContext) => void | Promise<void>

/** 保留一层薄封装，避免插件作者接触宿主内部对象。 */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin
}
