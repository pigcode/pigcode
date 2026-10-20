/** Host 侧插件的稳定入口类型；插件不直接依赖 Cordis 内部实现。 */
import type { ProviderPluginDriver } from "./provider"

/** Host 插件可用的最小上下文；只暴露稳定契约，不暴露 Host 内部服务。 */
export interface PluginHostContext {
  /** 注册一个供其他插件或 Host 使用的能力。 */
  provide(name: string, value: unknown): void
  /** 注册随插件卸载执行的清理逻辑。 */
  effect(setup: () => (() => void) | void): void
  providers: {
    register(driver: ProviderPluginDriver): void
    unregister(id: string): void
  }
}

export type HostPlugin = (ctx: PluginHostContext, config: unknown) => void | Promise<void>

/** 保留一层薄封装，未来可以在不破坏插件的情况下替换容器。 */
export function defineHostPlugin(plugin: HostPlugin): HostPlugin {
  return plugin
}
