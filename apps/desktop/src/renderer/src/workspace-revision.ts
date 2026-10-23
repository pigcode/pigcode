/** 文件树与打开的文件什么时候重读：agent 的工具调用结束、run 结束（含失败与中断）之后。 */
import type { ThreadEvent } from "@pigcode/contracts"

/** 可能改动了工作区的事件。只读工具也会触发一次重读，代价只是重新列出已展开的目录。 */
const MUTATING = new Set<ThreadEvent["type"]>([
  "tool.completed",
  "run.completed",
  "run.failed",
  "run.interrupted",
])

/** 最近一次可能改动工作区的事件序号；没有时为 0。序号单调递增，可以直接作为 revision。 */
export function workspaceRevision(events: readonly ThreadEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && MUTATING.has(event.type)) return event.seq
  }
  return 0
}
