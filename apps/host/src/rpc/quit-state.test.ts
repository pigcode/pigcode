/** 验证退出检查：只数真在跑的工作，取不到时不会挡住退出。 */
import { Context } from "cordis"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { attachQuitState, readQuitState, type QuitStatePort } from "./quit-state"

/** 只提供退出检查用到的服务：storage、agents 与可选的 schedules。 */
function context(options: { runs?: string[]; schedules?: number } = {}): Context {
  const ctx = new Context()
  const db = new Database(":memory:")
  db.exec("CREATE TABLE pending_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
  // 两条还挂着，一条已经处理过：只数前两条。
  for (const [id, status] of [
    ["a", "pending"],
    ["b", "pending"],
    ["c", "resolved"],
    ["d", "orphaned"],
  ]) {
    db.prepare("INSERT INTO pending_requests (id, status) VALUES (?, ?)").run(id, status)
  }
  const runs = options.runs ?? ["running", "queued", "completed"]
  ctx.provide("storage", { db } as never)
  ctx.provide("agents", {
    listRuns: () =>
      runs.map((status, index) => ({ runId: `r${String(index)}`, threadId: "t", status })),
  } as never)
  if (options.schedules !== undefined) {
    const list = Array.from({ length: options.schedules }, (_, index) => ({
      id: `s${String(index)}`,
      threadId: "t",
      prompt: "p",
      enabled: index % 2 === 0,
      status: index % 2 === 0 ? "active" : "paused",
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: null,
    }))
    ctx.provide("schedules", { list: () => list } as never)
  }
  return ctx
}

describe("quit state", () => {
  it("counts running and queued runs, pending requests and enabled schedules", () => {
    // 两个审批行，两条在跑/排队的 run，启用的定时任务只有偶数下标的一半。
    expect(readQuitState(context({ schedules: 3 }))).toEqual({
      runs: 2,
      approvals: 2,
      schedules: 2,
    })
  })

  it("still answers when there are no schedules or no table at all", () => {
    expect(readQuitState(context()).schedules).toBe(0)
    const bare = new Context()
    bare.provide("storage", { db: new Database(":memory:") } as never)
    bare.provide("agents", { listRuns: () => [] } as never)
    expect(readQuitState(bare)).toEqual({ runs: 0, approvals: 0, schedules: 0 })
  })

  it("answers on the control port and ignores other messages", () => {
    const ctx = context({ schedules: 1 })
    const sent: unknown[] = []
    let listener: ((value: unknown) => void) | undefined
    const port: QuitStatePort = {
      on: (_event, next) => {
        listener = next
      },
      postMessage: (message) => sent.push(message),
    }
    attachQuitState(port, ctx)
    listener?.({ data: { type: "browser.request", id: 1 } })
    expect(sent).toEqual([])
    listener?.({ data: { type: "app.quit-state", id: 7 } })
    expect(sent).toEqual([
      { type: "app.quit-state", id: 7, state: { runs: 2, approvals: 2, schedules: 1 } },
    ])
  })
})
