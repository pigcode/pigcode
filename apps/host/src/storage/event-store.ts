/** 只追加事件日志；写入与投影由上层在同一事务中完成。 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { PigcodeDatabase } from "./database"

/** 尚未分配 seq 的新线程事件。 */
export type NewThreadEvent = Omit<ThreadEvent, "seq">

/** 线程事件的持久化读写入口。 */
export class EventStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 追加一条事件并返回带 seq 的完整事件。 */
  append(event: NewThreadEvent): ThreadEvent {
    const result = this.db
      .prepare(
        `INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.threadId,
        event.runId,
        event.type,
        JSON.stringify(event.payload),
        event.schemaVersion,
        event.createdAt,
      )
    return {
      ...event,
      seq: Number(result.lastInsertRowid),
    }
  }

  /** 读取指定线程中 seq 大于游标的事件，按 seq 升序返回。 */
  read(threadId: string, afterSeq: number): ThreadEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, thread_id, run_id, type, payload_json, schema_version, created_at
         FROM thread_events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(threadId, afterSeq) as Array<{
      seq: number
      thread_id: string
      run_id: string | null
      type: ThreadEvent["type"]
      payload_json: string
      schema_version: 1
      created_at: string
    }>
    return rows.map((row) => ({
      seq: row.seq,
      threadId: row.thread_id,
      runId: row.run_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
    }))
  }
}
