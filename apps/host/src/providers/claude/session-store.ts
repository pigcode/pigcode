/** provider_sessions 持久化；同一线程复用最近一个活跃原生会话。 */
import type { ProviderSession } from "@pigcode/contracts"
import type { PigcodeDatabase } from "../../storage/database"
import type { ProviderSessionHandle } from "../driver"

/** provider 会话行的读写入口。 */
export class ProviderSessionStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 读取线程最近一个指定 provider 的活跃会话。 */
  findActive(threadId: string, providerId: string): ProviderSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_sessions
         WHERE thread_id = ? AND provider_id = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(threadId, providerId)
    return row ? mapProviderSession(row) : undefined
  }

  /**
   * 复用线程的活跃会话；不存在时插入 driver 新建的会话行。
   * 复用时保留原行 id 与 native id，供下一次 send 传 resume。
   */
  reuseOrCreate(input: {
    draft: ProviderSessionHandle
    providerId: string
    createdAt: string
  }): ProviderSessionHandle {
    const existing = this.findActive(input.draft.threadId, input.providerId)
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
        `INSERT INTO provider_sessions
         (id, thread_id, provider_id, native_session_id, cwd, status, created_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(
        input.draft.id,
        input.draft.threadId,
        input.providerId,
        input.draft.nativeSessionId,
        input.draft.cwd,
        input.createdAt,
      )
    return input.draft
  }

  /** provider 回报原生会话 id 后更新会话行。 */
  updateNativeSessionId(sessionId: string, nativeSessionId: string): void {
    this.db
      .prepare(`UPDATE provider_sessions SET native_session_id = ? WHERE id = ?`)
      .run(nativeSessionId, sessionId)
  }

  /** 读取线程的全部会话记录，按创建时间升序。 */
  listByThread(threadId: string): ProviderSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_sessions WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(threadId)
    return rows.map(mapProviderSession)
  }

  /** Host 重启时把遗留的活跃会话标记为 orphaned，返回影响行数。 */
  orphanActive(at: string): number {
    return this.db
      .prepare(
        `UPDATE provider_sessions SET status = 'orphaned', stopped_at = ? WHERE status = 'active'`,
      )
      .run(at).changes
  }
}

/** 把 provider_sessions 行映射为领域对象。 */
function mapProviderSession(row: unknown): ProviderSession {
  const value = row as Record<string, string | null>
  return {
    id: value.id!,
    threadId: value.thread_id!,
    providerId: value.provider_id!,
    nativeSessionId: value.native_session_id ?? null,
    cwd: value.cwd!,
    status: value.status as ProviderSession["status"],
    createdAt: value.created_at!,
    stoppedAt: value.stopped_at ?? null,
  }
}
