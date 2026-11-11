import type { ThreadEvent } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { latestContextUsage } from "./context-usage"

let seq = 0
const event = (
  type: ThreadEvent["type"],
  payload: unknown,
  runId: string | null = "r",
): ThreadEvent => ({
  seq: (seq += 1),
  threadId: "t",
  runId,
  type,
  payload,
  schemaVersion: 1,
  createdAt: "2026-11-11T00:00:00.000Z",
})
const usage = (usedTokens: number) =>
  event("context.updated", { usedTokens, maxTokens: 200000, autoCompactTokens: null })

describe("latestContextUsage", () => {
  it("takes the newest report", () => {
    expect(latestContextUsage([usage(10), usage(20)])).toEqual({
      usedTokens: 20,
      maxTokens: 200000,
      autoCompactTokens: null,
    })
  })

  it("forgets the numbers of a session the thread no longer uses", () => {
    const switched = event("thread.updated", { agentId: "codex" }, null)
    expect(latestContextUsage([usage(10), switched])).toBeNull()
    const lost = event("notice", { level: "warning", key: "session.resumeFailed" })
    expect(latestContextUsage([usage(10), lost])).toBeNull()
    expect(latestContextUsage([usage(10), switched, usage(5)])?.usedTokens).toBe(5)
  })

  it("is empty before any report", () => {
    expect(latestContextUsage([])).toBeNull()
  })
})
