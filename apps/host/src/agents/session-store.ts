/** agent_sessions 持久化；同一线程复用最近一个活跃原生会话。 */
import type { AgentSession } from "@pigcode/contracts"
import type { PigcodeDatabase } from "../storage/database"
import type { AgentSessionHandle } from "./driver"

/** Agent 会话行的读写入口。 */
export class AgentSessionStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 读取线程最近一个指定 Agent 的活跃会话。 */
  findActive(threadId: string, agentId: string): AgentSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE thread_id = ? AND agent_id = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(threadId, agentId)
    return row ? mapAgentSession(row) : undefined
  }

  /**
   * 复用线程的活跃会话；不存在时插入 driver 新建的会话行。
   * 复用时保留原行 id 与 native id，供下一次 send 传 resume。
   */
  reuseOrCreate(input: {
    draft: AgentSessionHandle
    agentId: string
    createdAt: string
  }): AgentSessionHandle {
    const existing = this.findActive(input.draft.threadId, input.agentId)
    if (existing) {
      return {
        ...input.draft,
        id: existing.id,
        cwd: existing.cwd,
        nativeSessionId: existing.nativeSessionId,
      }
    }
    this.db
      .prepare(
        `INSERT INTO agent_sessions
         (id, thread_id, agent_id, native_session_id, cwd, status, created_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(
        input.draft.id,
        input.draft.threadId,
        input.agentId,
        input.draft.nativeSessionId,
        input.draft.cwd,
        input.createdAt,
      )
    return input.draft
  }

  /** Agent 回报原生会话 id 后更新会话行。 */
  updateNativeSessionId(sessionId: string, nativeSessionId: string): void {
    this.db
      .prepare(`UPDATE agent_sessions SET native_session_id = ? WHERE id = ?`)
      .run(nativeSessionId, sessionId)
  }

  /** 把线程所有活跃会话标记为 stopped；切换 Agent 时调用。 */
  stopActive(threadId: string, at: string): number {
    return this.db
      .prepare(
        `UPDATE agent_sessions SET status = 'stopped', stopped_at = ?
         WHERE thread_id = ? AND status = 'active'`,
      )
      .run(at, threadId).changes
  }

  /** 读取线程的全部会话记录，按创建时间升序。 */
  listByThread(threadId: string): AgentSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_sessions WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(threadId)
    return rows.map(mapAgentSession)
  }

  /** Host 重启时把遗留的活跃会话标记为 orphaned，返回影响行数。 */
  orphanActive(at: string): number {
    return this.db
      .prepare(
        `UPDATE agent_sessions SET status = 'orphaned', stopped_at = ? WHERE status = 'active'`,
      )
      .run(at).changes
  }
}

/** 把 agent_sessions 行映射为领域对象。 */
function mapAgentSession(row: unknown): AgentSession {
  const value = row as Record<string, string | null>
  return {
    id: value.id!,
    threadId: value.thread_id!,
    agentId: value.agent_id!,
    nativeSessionId: value.native_session_id ?? null,
    cwd: value.cwd!,
    status: value.status as AgentSession["status"],
    createdAt: value.created_at!,
    stoppedAt: value.stopped_at ?? null,
  }
}
