/** Host 重启恢复：清理上一个进程遗留的 run、审批与 Agent 会话。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import type { PendingRequestStore } from "../storage/pending-request-store"
import type { AgentSessionStore } from "./session-store"

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
  agentSessions: AgentSessionStore,
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
  // 时间线只显示「已停止」，不说为什么。审批请求属于 agent 进程，随 Host 一起没了，
  // 没法重新发起，所以至少让用户知道是应用重启打断的（monorepo#6 的缺口 B）。
  // 带 runId 才落得进那一轮：runId 为 null 的事件不进时间线。
  for (const row of interrupted) {
    append(row.thread_id, row.id, "notice", { level: "warning", key: "host.restarted" })
  }
  const orphanedSessions = agentSessions.orphanActive(now)
  return { orphanedRequests, interruptedRuns, orphanedSessions }
}
