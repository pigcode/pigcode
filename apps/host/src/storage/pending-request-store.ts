/** 持久化待审批请求；Host 重启时统一标记 orphaned。 */
import {
  approvalDecisionSchema,
  type MobileRequestOutcome,
  type PendingRequest,
} from "@pigcode/contracts"
import type { PigcodeDatabase } from "./database"

export type StoredRequestResolution = Pick<MobileRequestOutcome, "decision" | "answers"> & {
  source: string
}

type RequestRow = Record<string, string | null>

function mapRequest(row: RequestRow): PendingRequest {
  return {
    id: row.id!,
    threadId: row.thread_id!,
    runId: row.run_id!,
    kind: row.kind as PendingRequest["kind"],
    agentRequestId: row.agent_request_id ?? null,
    payload: JSON.parse(row.payload_json!) as unknown,
    status: row.status as PendingRequest["status"],
    createdAt: row.created_at!,
    resolvedAt: row.resolved_at ?? null,
  }
}

/** 待审批/待回答请求的持久化读写入口。 */
export class PendingRequestStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 写入一条 pending 请求并返回完整记录。 */
  create(input: Omit<PendingRequest, "status" | "resolvedAt">): PendingRequest {
    const request: PendingRequest = { ...input, status: "pending", resolvedAt: null }
    this.db
      .prepare(
        `INSERT INTO pending_requests
         (id, thread_id, run_id, kind, agent_request_id, payload_json, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.threadId,
        request.runId,
        request.kind,
        request.agentRequestId,
        JSON.stringify(request.payload),
        request.status,
        request.createdAt,
        request.resolvedAt,
      )
    return request
  }

  get(id: string): (PendingRequest & { resolution?: StoredRequestResolution }) | undefined {
    const row = this.db.prepare(`SELECT * FROM pending_requests WHERE id = ?`).get(id) as
      RequestRow | undefined
    if (!row) return undefined
    return {
      ...mapRequest(row),
      ...(row.resolution_json
        ? { resolution: JSON.parse(row.resolution_json) as StoredRequestResolution }
        : {}),
    }
  }

  resolve(id: string, resolution?: StoredRequestResolution): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pending_requests
        SET status = 'resolved', resolved_at = ?, resolution_json = ?
        WHERE id = ? AND status = 'pending'`,
        )
        .run(new Date().toISOString(), resolution ? JSON.stringify(resolution) : null, id)
        .changes === 1
    )
  }

  /** 从已有会话的时间线读取升级前用户作出的决定。 */
  legacyResolution(request: PendingRequest): StoredRequestResolution | undefined {
    const event = this.db
      .prepare(
        `SELECT payload_json FROM thread_events
      WHERE thread_id = ? AND run_id = ? AND type = ?
        AND COALESCE(json_extract(payload_json, '$.requestId'), json_extract(payload_json, '$.id')) = ?
        AND json_extract(payload_json, '$.reason') IS NULL
      ORDER BY seq LIMIT 1`,
      )
      .get(
        request.threadId,
        request.runId,
        request.kind === "approval" ? "approval.resolved" : "question.answered",
        request.id,
      ) as { payload_json: string } | undefined
    if (!event) return undefined
    const payload = JSON.parse(event.payload_json) as { decision?: unknown; answers?: unknown }
    if (request.kind === "approval") {
      const decision = approvalDecisionSchema.safeParse(payload.decision)
      if (decision.success) return { decision: decision.data, source: "legacy" }
    } else if (
      Array.isArray(payload.answers) &&
      payload.answers.every((value) => typeof value === "string")
    ) {
      return { answers: payload.answers as string[], source: "legacy" }
    }
    return undefined
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
      .all(threadId) as RequestRow[]
    return rows.map(mapRequest)
  }
}
