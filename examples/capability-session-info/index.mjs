/** 示例 capability 插件：暴露当前线程事件数量。 */
export const inject = ["sessions"]

export function apply(ctx) {
  ctx.provide("sessionInfo", {
    count(threadId) {
      return ctx.sessions.read(threadId, 0).length
    },
  })
}
