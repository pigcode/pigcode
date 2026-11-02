/** 验证聊天页渲染用户消息、流式文本、审批按钮与按 Agent 功能显示的控件。 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentFeatures } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ChatView } from "./chat-view"

afterEach(cleanup)

/** 全部能力开启的基准，测试只覆盖需要关闭的单项。 */
const enabledCapabilities: AgentFeatures = {
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
function featuresWith(overrides: Partial<AgentFeatures>): AgentFeatures {
  return { ...enabledCapabilities, ...overrides }
}

/** 测试用线程。 */
const thread = {
  id: "t1",
  projectId: "p1",
  title: "First thread",
  defaultAgentId: "fake",
  lastAgentId: null,
  lastModelId: null,
  permissionMode: "workspace-write" as const,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  archivedAt: null,
  lastRunId: null,
}

/** 构造一条线程事件。 */
function event(seq: number, type: string, payload: unknown = {}) {
  return {
    seq,
    threadId: "t1",
    runId: "run_1",
    type,
    payload,
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  } as Parameters<typeof ChatView>[0]["events"][number]
}

describe("ChatView", () => {
  it("treats an interrupted run as finished and keeps its partial reply", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[
            event(1, "run.started", { text: "long task" }),
            event(2, "message.completed", {
              role: "assistant",
              text: "half an answer",
              partial: true,
            }),
            event(3, "run.interrupted"),
          ]}
          onInterrupt={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("half an answer").closest(".msg-ai")).not.toBeNull()
    expect(screen.getByRole("button", { name: "已停止" })).toBeTruthy()
    expect(screen.queryByText("运行中")).toBeNull()
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull()
  })

  it("offers copy and the reply time once a reply is finished", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const { rerender } = render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[
            event(1, "run.started", { text: "question" }),
            event(2, "message.completed", { role: "assistant", text: "part one" }),
          ]}
        />
      </LocaleProvider>,
    )
    expect(document.querySelector(".turn-actions")).toBeNull()

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[
            event(1, "run.started", { text: "question" }),
            event(2, "message.completed", { role: "assistant", text: "part one" }),
            event(3, "message.completed", { role: "assistant", text: "part two" }),
            event(4, "run.completed"),
          ]}
        />
      </LocaleProvider>,
    )
    const footer = document.querySelector<HTMLElement>(".turn-actions")!
    await userEvent.click(within(footer).getByRole("button", { name: "复制" }))
    expect(writeText).toHaveBeenCalledWith("part one\n\npart two")
    expect(await within(footer).findByRole("button", { name: "已复制" })).toBeTruthy()
    const time = footer.querySelector("time")
    expect(time?.getAttribute("datetime")).toBe("2026-10-20T00:00:00.000Z")
    expect(time?.textContent).not.toBe("")
    Reflect.deleteProperty(navigator, "clipboard")
  })

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
          features={featuresWith({ approvals: false })}
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
        <ChatView thread={thread} features={featuresWith({})} events={[]} streamingText="partial" />
      </LocaleProvider>,
    )
    expect(screen.getAllByRole("button", { name: "中断" }).length).toBeGreaterThan(0)

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          features={featuresWith({ streaming: false })}
          events={[]}
          streamingText="partial"
        />
      </LocaleProvider>,
    )
    expect(screen.queryAllByRole("button", { name: "中断" })).toHaveLength(0)
  })

  /** 输入框的模型胶囊显示当前 agent 的模型；选别的 agent 的模型交给容器切换。 */
  it("shows the thread's agent and model in the composer and switches across agents", async () => {
    const onSelectModel = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={{ ...thread, lastAgentId: "codex", lastModelId: "gpt-5" }}
          features={featuresWith({})}
          events={[]}
          agents={[
            { id: "codex", label: "Codex" },
            { id: "claude", label: "Claude Code" },
          ]}
          catalog={{
            codex: [
              { id: "gpt-5", label: "GPT-5", isDefault: true, efforts: [], defaultEffort: null },
            ],
            claude: [
              { id: "opus", label: "Opus", isDefault: true, efforts: [], defaultEffort: null },
            ],
          }}
          onSelectModel={onSelectModel}
        />
      </LocaleProvider>,
    )
    const chip = screen.getByRole("button", { name: /Agent 与模型/ })
    expect(chip.textContent).toContain("GPT-5")
    await userEvent.click(chip)
    await userEvent.click(await screen.findByRole("tab", { name: "Claude Code" }))
    await userEvent.click(await screen.findByText("Opus"))
    expect(onSelectModel).toHaveBeenCalledWith("claude", "opus")
  })

  /** plan 为 false 时 composer 的权限菜单里不能出现计划模式。 */
  it("hides the plan permission option when plan is unsupported", async () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          features={featuresWith({ plan: false })}
          events={[]}
          onPermissionMode={() => {}}
        />
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByRole("button", { name: "权限: 每次询问" }))
    expect(await screen.findByRole("menuitem", { name: /只读/ })).toBeTruthy()
    expect(screen.queryByText("计划模式")).toBeNull()
  })

  it("uses host layout controls in the header, or none when they live elsewhere", () => {
    const onToggleRight = vi.fn()
    const { rerender } = render(
      <LocaleProvider locale="zh-CN">
        <ChatView thread={thread} events={[]} onToggleRight={onToggleRight} />
      </LocaleProvider>,
    )
    expect(screen.getByRole("button", { name: "切换右侧面板" })).toBeTruthy()

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[]}
          onToggleRight={onToggleRight}
          layoutControls={<button type="button">layout</button>}
        />
      </LocaleProvider>,
    )
    expect(screen.getByRole("button", { name: "layout" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "切换右侧面板" })).toBeNull()

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView thread={thread} events={[]} onToggleRight={onToggleRight} layoutControls={null} />
      </LocaleProvider>,
    )
    expect(screen.queryByRole("button", { name: "切换右侧面板" })).toBeNull()
    expect(screen.queryByRole("button", { name: "layout" })).toBeNull()
  })

  it("puts the open-in entry in the thread header only when a thread is shown", () => {
    const openIn = <button type="button">IDE</button>
    const { container, rerender } = render(
      <LocaleProvider locale="zh-CN">
        <ChatView thread={thread} events={[]} openIn={openIn} />
      </LocaleProvider>,
    )
    expect(container.querySelector(".panel-top")?.textContent).toContain("IDE")

    rerender(
      <LocaleProvider locale="zh-CN">
        <ChatView thread={null} events={[]} openIn={openIn} />
      </LocaleProvider>,
    )
    expect(screen.queryByRole("button", { name: "IDE" })).toBeNull()
  })
})
