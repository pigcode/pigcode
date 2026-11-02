/** 创建并更新 run 行；状态变化与事件写入保持同步调用。 */
import type { RunStatus } from "@pigcode/contracts"
import type { PigcodeDatabase } from "./database"

/** run 行的持久化读写入口。 */
export class RunStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 写入一条新的 run 记录。 */
  create(input: {
    id: string
    threadId: string
    agentSessionId: string
    status: RunStatus
    startedAt: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.threadId, input.agentSessionId, input.status, input.startedAt)
  }

  /** 会话在 run 真正启动时才创建；排队阶段先写占位值。 */
  setAgentSessionId(runId: string, agentSessionId: string): void {
    this.db.prepare(`UPDATE runs SET agent_session_id = ? WHERE id = ?`).run(agentSessionId, runId)
  }

  /** 更新 run 状态；离开运行态时写入完成时间与错误信息。 */
  setStatus(runId: string, status: RunStatus, error?: { code: string; message: string }): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, completed_at = ?, error_code = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(
        status,
        status === "running" || status === "waiting-approval" || status === "queued"
          ? null
          : new Date().toISOString(),
        error?.code ?? null,
        error?.message ?? null,
        runId,
      )
  }
}
