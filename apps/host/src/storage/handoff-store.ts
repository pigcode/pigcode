/**
 * 交接记录（thread_handoffs）：每次把上下文交给另一个原生会话都记一行，写明交给谁、覆盖到会话的哪个位置、
 * 选了哪些条目、发出去没有。以前交接只是 thread.updated 里的一段文字，靠「后面有没有 run.started」猜它用掉没有。
 */
import type Database from "better-sqlite3"
import { randomUUID } from "node:crypto"

/**
 * 交接的来由：切换 Agent 时交接整个会话（switch），或者接回原来的原生会话、只补它离开后的增量（switch_delta）；
 * 原生会话接不上开了新会话（fresh_session）、子代理的第一条消息（subagent_brief）、
 * 用户在输入框里引用了别的会话（thread_reference）。
 */
export type HandoffStrategy =
  "switch" | "switch_delta" | "fresh_session" | "subagent_brief" | "thread_reference"

/**
 * 投递状态：pending 等下一轮带上；inline 已经拼在用户消息前发出；injected 已经作为历史注入原生会话；
 * superseded 还没发就被更新的交接取代了。
 */
export type HandoffDelivery = "pending" | "inline" | "injected" | "superseded"

export interface Handoff {
  id: string
  threadId: string
  strategy: HandoffStrategy
  fromInstanceIds: string[]
  toInstanceId: string | null
  /** 覆盖的会话位置范围（thread_items.position），没有条目时为 null。 */
  coveredFrom: number | null
  coveredTo: number | null
  selectedItemIds: string[]
  omittedCount: number
  text: string
  delivery: HandoffDelivery
  /** 带上这份交接的那一轮。 */
  targetRunId: string | null
  createdAt: string
}

export type NewHandoff = Pick<Handoff, "threadId" | "strategy" | "text"> &
  Partial<
    Pick<
      Handoff,
      | "fromInstanceIds"
      | "toInstanceId"
      | "coveredFrom"
      | "coveredTo"
      | "selectedItemIds"
      | "omittedCount"
    >
  >

/** 切换和新开会话的交接说的都是「到现在为止的对话」，新的一份出来，旧的还没发的就没用了。 */
const REPLACEABLE: readonly HandoffStrategy[] = ["switch", "switch_delta", "fresh_session"]

export class HandoffStore {
  constructor(private readonly db: Database.Database) {}

  /** 记一份待发的交接。 */
  create(input: NewHandoff): Handoff {
    const now = new Date().toISOString()
    const handoff: Handoff = {
      id: `ho_${randomUUID()}`,
      threadId: input.threadId,
      strategy: input.strategy,
      fromInstanceIds: input.fromInstanceIds ?? [],
      toInstanceId: input.toInstanceId ?? null,
      coveredFrom: input.coveredFrom ?? null,
      coveredTo: input.coveredTo ?? null,
      selectedItemIds: input.selectedItemIds ?? [],
      omittedCount: input.omittedCount ?? 0,
      text: input.text,
      delivery: "pending",
      targetRunId: null,
      createdAt: now,
    }
    this.db.transaction(() => {
      if (REPLACEABLE.includes(handoff.strategy)) {
        this.db
          .prepare(
            `UPDATE thread_handoffs SET delivery = 'superseded', updated_at = ?
             WHERE thread_id = ? AND delivery = 'pending'
               AND strategy IN (${REPLACEABLE.map(() => "?").join(", ")})`,
          )
          .run(now, handoff.threadId, ...REPLACEABLE)
      }
      this.db
        .prepare(
          `INSERT INTO thread_handoffs
             (id, thread_id, strategy, from_instance_ids, to_instance_id, covered_from, covered_to,
              selected_item_ids, omitted_count, text, delivery, target_run_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          handoff.id,
          handoff.threadId,
          handoff.strategy,
          JSON.stringify(handoff.fromInstanceIds),
          handoff.toInstanceId,
          handoff.coveredFrom,
          handoff.coveredTo,
          JSON.stringify(handoff.selectedItemIds),
          handoff.omittedCount,
          handoff.text,
          now,
          now,
        )
    })()
    return handoff
  }

  /**
   * 作废还没发出去的切换交接：又换了一次 Agent，之前那份说的是交给别的实例，已经没用了。
   */
  supersedeSwitches(threadId: string): void {
    this.db
      .prepare(
        `UPDATE thread_handoffs SET delivery = 'superseded', updated_at = ?
         WHERE thread_id = ? AND delivery = 'pending'
           AND strategy IN (${REPLACEABLE.map(() => "?").join(", ")})`,
      )
      .run(new Date().toISOString(), threadId, ...REPLACEABLE)
  }

  /** 这个会话还没发出去的交接，按记下的先后排。 */
  pending(threadId: string): Handoff[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_handoffs WHERE thread_id = ? AND delivery = 'pending'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(threadId) as Record<string, unknown>[]
    return rows.map(mapHandoff)
  }

  /** 这些交接已经随 runId 那一轮发出去了。 */
  markDelivered(ids: readonly string[], runId: string, how: "inline" | "injected"): void {
    if (ids.length === 0) return
    const now = new Date().toISOString()
    const update = this.db.prepare(
      `UPDATE thread_handoffs SET delivery = ?, target_run_id = ?, updated_at = ? WHERE id = ?`,
    )
    this.db.transaction(() => {
      for (const id of ids) update.run(how, runId, now, id)
    })()
  }

  /** 读一份交接；不存在时返回 undefined。 */
  get(id: string): Handoff | undefined {
    const row = this.db.prepare(`SELECT * FROM thread_handoffs WHERE id = ?`).get(id) as
      Record<string, unknown> | undefined
    return row ? mapHandoff(row) : undefined
  }

  /** 会话的全部交接，按先后排；测试和以后的增量交接用。 */
  list(threadId: string): Handoff[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_handoffs WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(threadId) as Record<string, unknown>[]
    return rows.map(mapHandoff)
  }
}

/** 几份待发的交接合成一段文字，拼在用户消息前。 */
export function joinHandoffs(handoffs: readonly Handoff[]): string | null {
  const texts = handoffs.map((handoff) => handoff.text.trim()).filter((text) => text.length > 0)
  return texts.length === 0 ? null : texts.join("\n\n")
}

function mapHandoff(row: Record<string, unknown>): Handoff {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    strategy: row.strategy as HandoffStrategy,
    fromInstanceIds: JSON.parse((row.from_instance_ids as string | null) ?? "[]") as string[],
    toInstanceId: (row.to_instance_id as string | null) ?? null,
    coveredFrom: (row.covered_from as number | null) ?? null,
    coveredTo: (row.covered_to as number | null) ?? null,
    selectedItemIds: JSON.parse((row.selected_item_ids as string | null) ?? "[]") as string[],
    omittedCount: (row.omitted_count as number | null) ?? 0,
    text: row.text as string,
    delivery: row.delivery as HandoffDelivery,
    targetRunId: (row.target_run_id as string | null) ?? null,
    createdAt: row.created_at as string,
  }
}
