/** 侧栏会话的状态：打开过的会话用事件推出的状态，其余用 Host 算的；主会话的状态也反映其子代理的工作。 */
import type { Thread } from "@pigcode/contracts"
import type { ThreadStatus } from "@pigcode/ui-shell"

const BUSY: ReadonlySet<ThreadStatus> = new Set(["running", "queued", "waiting-approval"])

/**
 * 每个会话的状态。打开的会话回放到达之前，事件推出的状态还是初始的 idle，这时用 Host 算的。
 * 主会话空闲而子代理仍在工作时，用子代理的状态。
 */
export function mergeChildStatus(
  threads: readonly Thread[],
  threadStates: Readonly<Record<string, { status: ThreadStatus; loaded?: boolean }>>,
): Record<string, ThreadStatus> {
  const result: Record<string, ThreadStatus> = {}
  for (const [threadId, viewState] of Object.entries(threadStates)) {
    result[threadId] = viewState.status
  }
  for (const thread of threads) {
    const viewState = threadStates[thread.id]
    if (!viewState?.loaded) result[thread.id] = thread.status ?? viewState?.status ?? "idle"
  }
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt !== null) continue
    const status = result[thread.id]
    const parent = result[thread.parentThreadId]
    if (status && BUSY.has(status) && !(parent && BUSY.has(parent))) {
      result[thread.parentThreadId] = status
    }
  }
  return result
}
