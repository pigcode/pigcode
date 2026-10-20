/** 验证子代理卡片默认折叠，并验证 MessageList 把 parent 事件归入卡片。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { MessageList } from "./message-list"
import { SubagentCard } from "./subagent-card"

afterEach(cleanup)

/** 构造一条线程事件；测试只关心 seq/type/payload。 */
function event(
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown,
  runId = "run_1",
): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  }
}

/** 子 agent 内部的消息与工具事件。 */
const childEvents = [
  event(2, "message.completed", {
    role: "assistant",
    text: "child reply",
    parentToolUseId: "task_1",
  }),
  event(3, "tool.started", {
    toolCallId: "read_1",
    name: "Read",
    input: "a.ts",
    parentToolUseId: "task_1",
  }),
  event(4, "tool.completed", {
    toolCallId: "read_1",
    name: "Read",
    output: "body",
    isError: false,
    parentToolUseId: "task_1",
  }),
]

describe("SubagentCard", () => {
  it("starts collapsed and expands to show child events", async () => {
    const { container } = render(
      <LocaleProvider locale="zh-CN">
        <SubagentCard
          subagent={{
            id: "task_1",
            name: "Explore",
            description: "Find the entry point",
            status: "completed",
            events: childEvents,
          }}
        />
      </LocaleProvider>,
    )
    const details = container.querySelector("details")
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(details?.getAttribute("data-status")).toBe("completed")
    expect(screen.getByText("Explore")).toBeTruthy()

    await userEvent.click(screen.getByText("Explore"))
    expect(details?.open).toBe(true)
    expect(screen.getByText("child reply")).toBeTruthy()
    expect(screen.getByText("Read")).toBeTruthy()
  })
})

describe("MessageList subagent timeline", () => {
  it("renders one card and hides parent-scoped events from the top level", () => {
    const events = [
      event(1, "subagent.started", {
        toolCallId: "task_1",
        name: "Explore",
        description: "Find the entry point",
      }),
      ...childEvents,
      event(5, "subagent.completed", {
        toolCallId: "task_1",
        isError: false,
        status: "completed",
      }),
      event(6, "message.completed", { role: "assistant", text: "parent reply" }),
      event(7, "run.completed", {}),
    ]
    const { container } = render(
      <LocaleProvider locale="zh-CN">
        <MessageList events={events} onApproval={() => {}} />
      </LocaleProvider>,
    )

    expect(screen.getByText("parent reply")).toBeTruthy()
    expect(screen.getAllByText("child reply")).toHaveLength(1)
    // 子 agent 的工具不再渲染为顶层工具卡。
    expect(screen.getAllByText("Read")).toHaveLength(1)
    const details = container.querySelector("details.subagent-card")
    expect(details?.getAttribute("data-status")).toBe("completed")
  })
})
