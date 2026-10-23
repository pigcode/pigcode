/** Host 重启恢复：清理上一个进程遗留的 run、审批与 provider 会话。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import type { PendingRequestStore } from "../storage/pending-request-store"
import type { ProviderSessionStore } from "./session-store"

/** Host 重启恢复时处理的行数。 */
export interface RestartRecovery {
  orphanedRequests: number
  interruptedRuns: number
  orphanedSessions: number
}

/** 写回终态事件，避免 Renderer 回放后永远停在 running。 */
export function recoverAfterRestart(
  ctx: Context,
  pendingRequests: PendingRequestStore,
  providerSessions: ProviderSessionStore,
  append: (
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ) => void,
): RestartRecovery {
  const now = new Date().toISOString()
  const orphanedRequests = pendingRequests.orphanAll()
  const interrupted = ctx.storage.db
    .prepare(
      `SELECT id, thread_id FROM runs
       WHERE status IN ('running', 'waiting-approval', 'queued')`,
    )
    .all() as Array<{ id: string; thread_id: string }>
  const interruptedRuns = ctx.storage.db
    .prepare(
      `UPDATE runs SET status = 'interrupted', completed_at = ?
       WHERE status IN ('running', 'waiting-approval', 'queued')`,
    )
    .run(now).changes
  for (const row of interrupted) {
    append(row.thread_id, row.id, "run.interrupted", { reason: "host-restart" })
  }
  const orphanedSessions = providerSessions.orphanActive(now)
  return { orphanedRequests, interruptedRuns, orphanedSessions }
}
