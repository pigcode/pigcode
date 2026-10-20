/** 验证聊天页渲染用户消息、流式文本和审批按钮。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ChatView } from "./chat-view"

/** 测试用线程。 */
const thread = {
  id: "t1",
  projectId: "p1",
  title: "First thread",
  defaultProviderId: "fake",
  lastProviderId: null,
  lastModelId: null,
  permissionMode: "workspace-write" as const,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  archivedAt: null,
  lastRunId: null,
}

describe("ChatView", () => {
  it("renders persisted and streaming content", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[
            {
              seq: 1,
              threadId: "t1",
              runId: null,
              type: "message.completed",
              payload: { text: "Done" },
              schemaVersion: 1,
              createdAt: "2026-10-20T00:00:00.000Z",
            },
          ]}
          streamingText="Streaming"
          onStart={() => {}}
          onInterrupt={() => {}}
          onApproval={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("Done")).toBeTruthy()
    expect(screen.getByText("Streaming")).toBeTruthy()
  })

  /** 点击允许一次时应把请求 id 与决议回传。 */
  it("submits an approval decision", async () => {
    const onApproval = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[
            {
              seq: 1,
              threadId: "t1",
              runId: "run_1",
              type: "approval.requested",
              payload: { id: "req-1", title: "允许运行命令吗？", command: "echo hi" },
              schemaVersion: 1,
              createdAt: "2026-10-20T00:00:00.000Z",
            },
          ]}
          onStart={() => {}}
          onInterrupt={() => {}}
          onApproval={onApproval}
        />
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByRole("button", { name: "允许一次" }))
    expect(onApproval).toHaveBeenCalledWith("req-1", "allow-once")
  })
})
