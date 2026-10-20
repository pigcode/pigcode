/** 验证聊天页渲染用户消息、流式文本、审批按钮与 capability 驱动的控件。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProviderCapabilities } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ChatView } from "./chat-view"

afterEach(cleanup)

/** 全部能力开启的基准，测试只覆盖需要关闭的单项。 */
const enabledCapabilities: ProviderCapabilities = {
  streaming: true,
  approvals: true,
  questions: false,
  plan: true,
  resume: true,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: false,
  images: false,
  usage: true,
  modelCatalog: true,
  nativeSessionId: true,
}

/** 在基准能力上覆盖指定字段。 */
function capabilitiesWith(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return { ...enabledCapabilities, ...overrides }
}

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

  /** approvals 为 false 时不得渲染审批卡片，也不能进入等待许可状态。 */
  it("hides approval controls when approvals is unsupported", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          capabilities={capabilitiesWith({ approvals: false })}
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
          onApproval={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull()
    expect(screen.queryByText("等待许可")).toBeNull()
  })

  /** streaming 为 false 时线程头与 composer 都不显示停止入口。 */
  it("hides interrupt controls when streaming is unsupported", () => {
    const { rerender } = render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          capabilities={capabilitiesWith({})}
          events={[]}
          streamingText="partial"
        />
      </LocaleProvider>,
    )
    expect(screen.getAllByRole("button", { name: "中断" }).length).toBeGreaterThan(0)

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          capabilities={capabilitiesWith({ streaming: false })}
          events={[]}
          streamingText="partial"
        />
      </LocaleProvider>,
    )
    expect(screen.queryAllByRole("button", { name: "中断" })).toHaveLength(0)
  })

  /** modelCatalog 为 false 时，模型菜单在允许列表存在时也必须隐藏。 */
  it("hides model menus when the catalog is unsupported", () => {
    const modelThread = { ...thread, lastModelId: "gpt-5" }
    const { rerender } = render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={modelThread}
          capabilities={capabilitiesWith({})}
          events={[]}
          models={["gpt-5"]}
          onSwitchModel={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0)

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={modelThread}
          capabilities={capabilitiesWith({ modelCatalog: false })}
          events={[]}
          models={["gpt-5"]}
          onSwitchModel={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.queryByText("gpt-5")).toBeNull()
  })

  /** plan 为 false 时 composer 的权限菜单里不能出现计划模式。 */
  it("hides the plan permission option when plan is unsupported", async () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          capabilities={capabilitiesWith({ plan: false })}
          events={[]}
        />
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByRole("button", { name: "每次询问" }))
    expect(await screen.findByText("自动改文件")).toBeTruthy()
    expect(screen.queryByText("只做计划")).toBeNull()
  })
})
