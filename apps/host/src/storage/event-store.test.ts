/** 验证 SQLite 事件日志与命令回执的读写行为。 */
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { EventStore } from "./event-store"
import { ReceiptStore } from "./receipt-store"

describe("event store", () => {
  it("appends and reads events after a cursor", () => {
    const db = openDatabase(":memory:")
    const store = new EventStore(db)
    store.append({
      threadId: "th_1",
      runId: null,
      type: "thread.created",
      payload: { title: "hello" },
      schemaVersion: 1,
      createdAt: "2026-10-20T00:00:00.000Z",
    })
    store.append({
      threadId: "th_1",
      runId: "run_1",
      type: "run.started",
      payload: {},
      schemaVersion: 1,
      createdAt: "2026-10-20T00:00:01.000Z",
    })

    const all = store.read("th_1", 0)
    const after = store.read("th_1", all[0]!.seq)
    expect(all).toHaveLength(2)
    expect(after).toHaveLength(1)
    expect(after[0]!.type).toBe("run.started")
    db.close()
  })

  it("stores command receipts idempotently", () => {
    const db = openDatabase(":memory:")
    const receipts = new ReceiptStore(db)
    receipts.put("cmd-1", { ok: true })
    expect(receipts.get("cmd-1")).toEqual({ ok: true })
    expect(receipts.get("missing")).toBeUndefined()
    db.close()
  })
})
