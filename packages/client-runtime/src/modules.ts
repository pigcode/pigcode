/** 读取 boot graph、动态加载 client bundle、应用并返回 disposer。 */
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

/** 加载器依赖；load 与 context 由调用方注入，便于测试与替换。 */
export interface LoadClientPluginsOptions {
  boot: BootGraph
  load: (url: string) => Promise<ClientModule>
  context: () => ClientPluginContext
}

/** 按 boot graph 顺序应用插件；返回统一卸载函数（逆序执行）。 */
export async function loadClientPlugins(
  options: LoadClientPluginsOptions,
): Promise<{ dispose(): void }> {
  const disposers: Array<() => void> = []
  for (const entry of options.boot.entries) {
    const module = await options.load(entry.url)
    const result = module.apply?.(options.context())
    if (typeof result === "function") disposers.push(result)
  }
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}
