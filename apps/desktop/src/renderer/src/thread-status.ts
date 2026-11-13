/** 侧栏主会话的状态也反映其子代理的工作。 */
import type { Thread } from "@pigcode/contracts"
import type { ThreadStatus } from "@pigcode/ui-shell"

const BUSY: ReadonlySet<ThreadStatus> = new Set(["running", "queued", "waiting-approval"])

/** 主会话空闲而子代理仍在工作时，用子代理的状态。 */
export function mergeChildStatus(
  threads: readonly Thread[],
  threadStates: Readonly<Record<string, { status: ThreadStatus }>>,
): Record<string, ThreadStatus> {
  const result: Record<string, ThreadStatus> = {}
  for (const [threadId, viewState] of Object.entries(threadStates)) {
    result[threadId] = viewState.status
  }
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt !== null) continue
    const status = threadStates[thread.id]?.status
    const parent = result[thread.parentThreadId]
    if (status && BUSY.has(status) && !(parent && BUSY.has(parent))) {
      result[thread.parentThreadId] = status
    }
  }
  return result
}
