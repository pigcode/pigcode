/** 验证子 agent 行：点击在标签页中打开；没有标签页可开时展开看过程；主时间线不显示它内部的事件。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { MessageList } from "./message-list"
import { AgentRow, type SubagentCall } from "./subagent-card"
import { SubagentView } from "./subagent-view"
import { resetToolOpen } from "./tool-open"
import { WithToolRenderers } from "./tools/tool-renderers.fixtures"
import { ConversationActionsContext } from "./tools"

afterEach(() => {
  cleanup()
  resetToolOpen()
})

function event(seq: number, type: ThreadEvent["type"], payload: unknown): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId: "run_1",
    type,
    payload,
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  }
}

const childEvents = [
  event(2, "message.completed", {
    role: "assistant",
    text: "child reply",
    parentToolUseId: "task_1",
  }),
  event(3, "tool.started", {
    toolCallId: "read_1",
    name: "Read",
    input: { file_path: "a.ts" },
    parentToolUseId: "task_1",
  }),
  event(4, "tool.completed", {
    toolCallId: "read_1",
    name: "Read",
    output: "body",
    parentToolUseId: "task_1",
  }),
]

const RUNNING: SubagentCall = {
  id: "task_1",
  name: "Explore",
  description: "Find the entry point",
  prompt: "Look for the main export.",
  status: "running",
  events: childEvents,
}

const SUBAGENT: SubagentCall = { ...RUNNING, status: "completed", output: "It is src/index.ts." }

function inLocale(node: ReactNode) {
  return render(
    <LocaleProvider locale="zh-CN">
      <WithToolRenderers>{node}</WithToolRenderers>
    </LocaleProvider>,
  )
}

describe("AgentRow", () => {
  it("opens the sub-agent in a tab instead of expanding in place", async () => {
    const opened: string[] = []
    inLocale(
      <ConversationActionsContext.Provider value={{ onOpenSubagent: (id) => opened.push(id) }}>
        <AgentRow subagent={SUBAGENT} />
      </ConversationActionsContext.Provider>,
    )
    const row = screen.getByRole("button", { name: "在标签页中打开 Explore" })
    expect(row.textContent).toBe("子智能体Explore·Find the entry point")
    await userEvent.click(row)
    expect(opened).toEqual(["task_1"])
    expect(screen.queryByText("child reply")).toBeNull()
  })

  it("expands to the task, the steps and the result when there is no tab to open", async () => {
    inLocale(<AgentRow subagent={RUNNING} />)
    const row = screen.getByRole("button", { name: /子智能体/ })
    expect(row.querySelector(".tool-shimmer")?.textContent).toBe("子智能体")
    expect(row.textContent).toContain("正在读取 a.ts")
    await userEvent.click(row)
    expect(screen.getByText("Look for the main export.")).toBeTruthy()
    expect(screen.getByText("child reply")).toBeTruthy()
  })
})

describe("sub-agents in the timeline", () => {
  it("renders one row and keeps the sub-agent's own events out of the main turn", async () => {
    inLocale(
      <MessageList
        events={[
          event(1, "subagent.started", {
            toolCallId: "task_1",
            name: "Explore",
            description: "Find the entry point",
          }),
          ...childEvents,
          event(5, "subagent.completed", { toolCallId: "task_1", status: "completed" }),
          event(6, "message.completed", { role: "assistant", text: "parent reply" }),
          event(7, "run.completed", {}),
        ]}
        onApproval={() => {}}
      />,
    )
    expect(screen.getByText("parent reply")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: /已工作|已处理/ }))
    expect(screen.getAllByRole("button", { name: /子智能体/ })).toHaveLength(1)
    expect(screen.queryByText("child reply")).toBeNull()
    expect(screen.queryByText("读取")).toBeNull()
  })

  it("shows the sub-agent's steps with the same tool rows in its own tab", () => {
    inLocale(<SubagentView subagent={SUBAGENT} />)
    expect(screen.getByText("Look for the main export.")).toBeTruthy()
    expect(screen.getByText("child reply")).toBeTruthy()
    expect(screen.getByText("读取")).toBeTruthy()
    expect(screen.getByText("It is src/index.ts.")).toBeTruthy()
  })
})
