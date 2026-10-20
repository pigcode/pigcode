/** 验证聊天页渲染用户消息、流式文本和工具卡片。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ChatView } from "./chat-view"

describe("ChatView", () => {
  it("renders persisted and streaming content", () => {
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
})
