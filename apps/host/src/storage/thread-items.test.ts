/** 会话条目从事件日志投影出来（#77）：实时写入和迁移回填得到一样的结果，事件和条目一起提交。 */
import type { ThreadEvent } from "@pigcode/contracts"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { EventStore, type NewThreadEvent } from "./event-store"
import { migrate } from "./migrations"
import { ThreadItemStore } from "./thread-items"

const T = "thread_1"
let clock = 0
function e(
  type: ThreadEvent["type"],
  payload: unknown,
  runId: string | null = "run_1",
): NewThreadEvent {
  clock += 1
  return {
    threadId: T,
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: new Date(clock * 1000).toISOString(),
  }
}

/** 一轮里有用户消息、命令、改文件、读文件、计划、子 agent 内部的消息、回答，第二轮失败。 */
const EVENTS: NewThreadEvent[] = [
  e("message.completed", { role: "user", text: "fix the parser" }),
  e("run.started", { agentId: "claude", instanceId: "claude", agentSessionId: "s1" }),
  e("tool.started", { toolCallId: "c1", name: "Bash", input: { command: "pnpm test" } }),
  e("tool.completed", {
    toolCallId: "c1",
    name: "Bash",
    output: "1 failed",
    isError: true,
    exitCode: 1,
  }),
  e("tool.started", { toolCallId: "c2", name: "Edit", input: { file_path: "src/parser.ts" } }),
  e("tool.completed", { toolCallId: "c2", name: "Edit", output: "ok", isError: false }),
  e("tool.started", { toolCallId: "c3", name: "Read", input: { file_path: "README.md" } }),
  e("tool.completed", { toolCallId: "c3", name: "Read", output: "# readme", isError: false }),
  e("tool.started", {
    toolCallId: "c4",
    name: "ApplyPatch",
    input: [{ path: "a.ts" }, { path: "b.ts" }],
  }),
  e("plan.updated", { plan: [{ step: "write tests", status: "completed" }], explanation: null }),
  e("message.completed", { role: "assistant", text: "inner", parentToolUseId: "task_1" }),
  e("message.completed", { role: "assistant", text: "fixed it" }),
  e("run.completed", {}),
  e("message.completed", { role: "user", text: "now docs" }, "run_2"),
  e("run.failed", { message: "rate limited" }, "run_2"),
]

function freshDb(): Database.Database {
  const db = new Database(":memory:")
  migrate(db)
  return db
}

function project(db: Database.Database): ReturnType<ThreadItemStore["list"]> {
  return new ThreadItemStore(db).list(T, { includeSubagents: true })
}

describe("thread items", () => {
  it("turns the event log into readable items", () => {
    const db = freshDb()
    const store = new EventStore(db)
    for (const event of EVENTS) store.append(event)
    const items = new ThreadItemStore(db).list(T)
    expect(items.map((item) => [item.kind, item.status, item.text])).toEqual([
      ["user_message", "completed", "fix the parser"],
      ["command", "failed", "Command: pnpm test\nExit code: 1\n1 failed"],
      ["file_change", "completed", "File change: src/parser.ts"],
      ["tool", "completed", 'Tool: Read {"file_path":"README.md"}\n# readme'],
      ["file_change", "running", "File change: a.ts, b.ts"],
      ["plan", "completed", "Plan:\n- write tests [completed]"],
      ["assistant_message", "completed", "fixed it"],
      ["user_message", "completed", "now docs"],
      ["error", "failed", "rate limited"],
    ])
    // 子 agent 内部的消息默认不列出，要的时候能读到。
    expect(
      project(db).some((item) => item.text === "inner" && item.parentToolUseId === "task_1"),
    ).toBe(true)
    expect(new ThreadItemStore(db).list(T, { kinds: ["command"] })).toHaveLength(1)
    expect(new ThreadItemStore(db).list(T, { excludeRunId: "run_2" }).at(-1)?.text).toBe("fixed it")
  })

  it("backfills the same items from an existing event log", () => {
    const live = freshDb()
    for (const event of EVENTS) new EventStore(live).append(event)

    // 迁到上一个版本、只写事件，再迁到最新：回填出的条目和实时写入的一样。
    const old = new Database(":memory:")
    migrate(old, 2)
    const insert = old.prepare(
      `INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    for (const event of EVENTS) {
      insert.run(
        event.threadId,
        event.runId,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt,
      )
    }
    migrate(old)
    expect(project(old)).toEqual(project(live))
  })

  it("carries a handoff that was still pending over to the new table", () => {
    const old = new Database(":memory:")
    migrate(old, 2)
    const insert = old.prepare(
      `INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
       VALUES (?, ?, ?, ?, 1, 'x')`,
    )
    insert.run("a", null, "thread.updated", JSON.stringify({ agentId: "codex", handoff: "sent" }))
    insert.run("a", "r", "run.started", JSON.stringify({}))
    insert.run(
      "b",
      null,
      "thread.updated",
      JSON.stringify({ agentId: "codex", handoff: "waiting" }),
    )
    migrate(old)
    const rows = old
      .prepare(`SELECT thread_id, strategy, text, delivery FROM thread_handoffs`)
      .all()
    expect(rows).toEqual([
      { thread_id: "b", strategy: "switch", text: "waiting", delivery: "pending" },
    ])
  })

  it("does not keep an event whose item could not be written", () => {
    const db = freshDb()
    const store = new EventStore(db)
    db.exec(`DROP TABLE thread_items`)
    expect(() => store.append(EVENTS[0]!)).toThrow()
    expect(db.prepare(`SELECT COUNT(*) AS count FROM thread_events`).get()).toEqual({ count: 0 })
  })
})

// openDatabase 也走同一套迁移；这里只确认新表在。
describe("database", () => {
  it("has the item and handoff tables", () => {
    const db = openDatabase(":memory:")
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'thread_%'`)
      .all()
      .map((row) => (row as { name: string }).name)
    expect(tables).toEqual(
      expect.arrayContaining(["thread_events", "thread_items", "thread_handoffs"]),
    )
  })
})
