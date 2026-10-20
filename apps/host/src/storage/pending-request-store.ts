/** 持久化待审批请求；Host 重启时统一标记 orphaned。 */
import type { PendingRequest } from "@pigcode/contracts"
import type { PigcodeDatabase } from "./database"

/** 待审批/待回答请求的持久化读写入口。 */
export class PendingRequestStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 写入一条 pending 请求并返回完整记录。 */
  create(input: Omit<PendingRequest, "status" | "resolvedAt">): PendingRequest {
    const request: PendingRequest = { ...input, status: "pending", resolvedAt: null }
    this.db
      .prepare(
        `INSERT INTO pending_requests
         (id, thread_id, run_id, kind, provider_request_id, payload_json, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.threadId,
        request.runId,
        request.kind,
        request.providerRequestId,
        JSON.stringify(request.payload),
        request.status,
        request.createdAt,
        request.resolvedAt,
      )
    return request
  }

  /** 把请求标记为已解决；重复调用是幂等的。 */
  resolve(id: string): void {
    this.db
      .prepare(`UPDATE pending_requests SET status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
  }

  /** Host 重启时把所有仍 pending 的请求标记为 orphaned，返回影响行数。 */
  orphanAll(): number {
    return this.db
      .prepare(
        `UPDATE pending_requests SET status = 'orphaned', resolved_at = ? WHERE status = 'pending'`,
      )
      .run(new Date().toISOString()).changes
  }

  /** 读取指定线程中仍处于 pending 的请求，按创建时间升序。 */
  listPending(threadId: string): PendingRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_requests WHERE thread_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      )
      .all(threadId) as Array<Record<string, string | null>>
    return rows.map((row) => ({
      id: row.id!,
      threadId: row.thread_id!,
      runId: row.run_id!,
      kind: row.kind as PendingRequest["kind"],
      providerRequestId: row.provider_request_id ?? null,
      payload: JSON.parse(row.payload_json!) as unknown,
      status: row.status as PendingRequest["status"],
      createdAt: row.created_at!,
      resolvedAt: row.resolved_at ?? null,
    }))
  }
}
