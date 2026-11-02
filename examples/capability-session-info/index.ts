/** 示例 capability 插件：暴露当前线程事件数量。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "capability-session-info"
export const inject = ["sessions"]

/** 其他插件通过 `sessionInfo` 服务读取的接口。 */
export interface SessionInfo {
  count(threadId: string): number
}

export function apply(ctx: PluginHostContext): void {
  const info: SessionInfo = {
    count(threadId) {
      return ctx.sessions.read(threadId, 0).length
    },
  }
  ctx.provide("sessionInfo", info)
  ctx.effect(() => () => {})
}
