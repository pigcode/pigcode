/** Host 侧插件的稳定入口类型；插件不直接依赖 Cordis 内部实现。 */
import type { Context } from "cordis"

export type HostPlugin = (ctx: Context, config: unknown) => void | Promise<void>

/** 保留一层薄封装，未来可以在不破坏插件的情况下替换容器。 */
export function defineHostPlugin(plugin: HostPlugin): HostPlugin {
  return plugin
}
