/** boot graph 的形状与单个 client bundle 的应用；按插件加载、卸载由宿主的插件控制器负责。 */
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

/** boot graph 中的单个客户端入口。 */
export interface BootEntry {
  id: string
  url: string
  revision: string
  inject: string[]
}

/** Host 下发的客户端启动图。 */
export interface BootGraph {
  entries: BootEntry[]
}

/** 客户端 bundle 需要导出的最小模块形状。 */
export interface ClientModule {
  apply?: (ctx: ClientPluginContext) => void | (() => void)
}

/** 应用一个插件模块；返回它的清理函数（没有时是空函数）。apply 抛出的错误原样抛出。 */
export function applyClientPlugin(module: ClientModule, ctx: ClientPluginContext): () => void {
  const result = module.apply?.(ctx)
  return typeof result === "function" ? result : () => undefined
}
