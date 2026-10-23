/** 验证文件树重读的时机：工具调用与 run 结束时序号前进，其他事件不影响。 */
import { describe, expect, it } from "vitest"
import type { ThreadEvent } from "@pigcode/contracts"
import { workspaceRevision } from "./workspace-revision"

function event(seq: number, type: ThreadEvent["type"]): ThreadEvent {
  return {
    seq,
    threadId: "th",
    runId: "run",
    type,
    payload: {},
    schemaVersion: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
  }
}

describe("workspace revision", () => {
  it("follows the latest tool or run completion", () => {
    expect(workspaceRevision([])).toBe(0)
    expect(workspaceRevision([event(1, "message.completed"), event(2, "run.started")])).toBe(0)
    expect(
      workspaceRevision([
        event(1, "run.started"),
        event(2, "tool.completed"),
        event(3, "message.completed"),
      ]),
    ).toBe(2)
    expect(workspaceRevision([event(4, "tool.completed"), event(9, "run.interrupted")])).toBe(9)
  })
})
