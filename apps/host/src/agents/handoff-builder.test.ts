/** 交接按预算挑选完整条目（#79），规则对照 t3code 的 ContextHandoffBudget 测试。 */
import { describe, expect, it } from "vitest"
import type { ThreadItem, ThreadItemKind } from "../storage/thread-items"
import { buildSelection, handoffBudget } from "./handoff-builder"

let position = 0
function item(kind: ThreadItemKind, text: string, extra: Partial<ThreadItem> = {}): ThreadItem {
  position += 1
  return {
    id: `i${position}`,
    threadId: "t",
    position,
    kind,
    runId: `r${position}`,
    agentId: "codex",
    instanceId: "codex",
    agentSessionId: "s",
    parentToolUseId: null,
    status: "completed",
    text,
    ...extra,
  }
}

const select = (items: ThreadItem[], budget: number) =>
  buildSelection({ items, heading: "Context handoff.", threadId: "t", budget })!

describe("handoff selection", () => {
  it("carries a short conversation over whole and in order", () => {
    const items = [
      item("user_message", "build the parser"),
      item("command", "Command: pnpm test\nExit code: 1\n1 failed"),
      item("file_change", "File change: src/parser.ts"),
      item("assistant_message", "fixed"),
    ]
    const selection = select(items, 16_000)
    expect(selection.omittedCount).toBe(0)
    expect(selection.selectedItemIds).toEqual(["i1", "i2", "i3", "i4"])
    expect(selection.text).not.toContain("pigcode_thread_read")
    expect(selection.text.indexOf("build the parser")).toBeLessThan(selection.text.indexOf("fixed"))
  })

  it("keeps the first and the last request of a long conversation", () => {
    const items = [item("user_message", "FIRST GOAL")]
    for (let index = 0; index < 60; index += 1) {
      items.push(item("assistant_message", `step ${index} ${"x".repeat(400)}`))
    }
    items.push(item("user_message", "LAST REQUEST"))
    const selection = select(items, 6_000)
    expect(selection.text).toContain("FIRST GOAL")
    expect(selection.text).toContain("LAST REQUEST")
    expect(selection.omittedCount).toBeGreaterThan(0)
    // 省略了东西时告诉 agent 去哪里读。
    expect(selection.text).toContain('pigcode_thread_read tool: {"threadId":"t"}')
    // 挑出来的最近几条是最新的那几条。
    expect(selection.text).toContain("step 59")
    expect(selection.text).not.toContain("step 0 ")
  })

  it("skips an item that does not fit instead of cutting it", () => {
    const huge = "y".repeat(20_000)
    const items = [
      item("user_message", "goal"),
      item("command", huge),
      item("assistant_message", "done"),
    ]
    const selection = select(items, 4_000)
    expect(selection.text).not.toContain("yyyy")
    expect(selection.text).toContain("goal")
    expect(selection.text).toContain("done")
    expect(selection.omittedCount).toBe(1)
  })

  it("leaves out reads, searches and a sub-agent's inner work", () => {
    const items = [
      item("user_message", "goal"),
      item("tool", "Tool: Read README.md"),
      item("assistant_message", "inner", { parentToolUseId: "task" }),
      item("assistant_message", "done"),
    ]
    const selection = select(items, 16_000)
    expect(selection.selectedItemIds).toEqual([items[0]!.id, items[3]!.id])
    expect(selection.text).not.toContain("README")
    expect(selection.text).not.toContain("inner")
  })

  it("is empty when there is nothing to hand over", () => {
    expect(buildSelection({ items: [], heading: "h", threadId: "t", budget: 16_000 })).toBeNull()
  })

  it("still points to the history when no item fits", () => {
    const selection = select([item("user_message", "goal")], 0)
    expect(selection.selectedItemIds).toEqual([])
    expect(selection.text).toContain("omitted 1")
    expect(selection.text).toContain("pigcode_thread_read")
  })
})

describe("handoff budget", () => {
  it("caps history at 16k by default", () => {
    expect(handoffBudget({ userText: "hi" })).toBe(16_000)
  })

  it("leaves room for the work in small windows", () => {
    // 8k、16k 的小窗口：工作预留不超过半个窗口，仍然能放进一些历史。
    expect(
      handoffBudget({
        userText: "hi",
        target: { usedTokens: 0, maxTokens: 8_000, autoCompactTokens: null },
      }),
    ).toBeGreaterThan(3_000)
    expect(
      handoffBudget({
        userText: "hi",
        target: { usedTokens: 0, maxTokens: 16_000, autoCompactTokens: null },
      }),
    ).toBeGreaterThan(7_000)
  })

  it("measures against the compaction line and what is already used", () => {
    const target = { usedTokens: 150_000, maxTokens: 1_000_000, autoCompactTokens: 200_000 }
    // 200k − 150k − 预留 50k ≈ 0。
    expect(handoffBudget({ userText: "hi", target })).toBe(0)
  })

  it("counts the user's text and attachments, never cutting the text", () => {
    // 30k 窗口：预留 15k，留给历史的不到 16k 上限，附件的占用直接体现出来。
    const target = { usedTokens: 0, maxTokens: 30_000, autoCompactTokens: null }
    const plain = handoffBudget({ userText: "hi", target })
    expect(plain).toBeLessThan(16_000)
    expect(handoffBudget({ userText: "hi", target, images: 1 })).toBe(plain - 8_192)
    expect(handoffBudget({ userText: "z".repeat(30_000), target })).toBe(0)
  })
})
