/** 验证线程头标签栏、派生子代理的只读视图与时间线里的「在标签页中打开」。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatView } from "./chat-view"
import { collectSubagents } from "./event-parsers"
import { MessageList } from "./message-list"
import { ThreadTabs, type ThreadTab } from "./thread-tabs"
import { buildTimeline } from "./turns"

afterEach(cleanup)

function event(
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown,
  runId: string | null = "run_1",
): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
  }
}

const TABS: ThreadTab[] = [
  { id: "main", kind: "main", title: "修登录", running: true },
  {
    id: "agent:c1",
    kind: "agent",
    title: "Codex 子代理",
    agentId: "codex",
    running: true,
    closable: true,
  },
  {
    id: "agent:c2",
    kind: "agent",
    title: "Claude 子代理",
    agentId: "claude",
    waiting: true,
    closable: true,
  },
  {
    id: "spawned:s1",
    kind: "spawned",
    title: "梳理入口",
    description: "Explore · 梳理入口",
    closable: true,
  },
]

const AGENTS = [
  { id: "claude", agentId: "claude", label: "Claude Code", installed: true },
  { id: "codex", agentId: "codex", label: "Codex", installed: false },
]

function renderTabs(overrides: Partial<Parameters<typeof ThreadTabs>[0]> = {}) {
  const props = {
    tabs: TABS,
    activeId: "main",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    agents: AGENTS,
    ...overrides,
  }
  render(
    <LocaleProvider locale="zh-CN">
      <ThreadTabs {...props} />
    </LocaleProvider>,
  )
  return props
}

describe("ThreadTabs", () => {
  it("shows run state only on sub-agent tabs", () => {
    renderTabs()
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "修登录",
      "Codex 子代理",
      "Claude 子代理",
      "梳理入口",
    ])
    // 子代理标签带所用 Agent 的品牌标志：Codex 是 OpenAI，Claude Code 是 Anthropic。
    expect(tabs[1]?.querySelector(".agent-brand")?.getAttribute("data-brand")).toBe("openai")
    expect(tabs[2]?.querySelector(".agent-brand")?.getAttribute("data-brand")).toBe("claude")
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true")
    // 主会话标签不显示运行状态，运行状态只在侧栏和时间线里。
    expect(tabs[0]?.querySelector(".dot-matrix")).toBeNull()
    expect(within(tabs[1]!).getByRole("img", { name: "运行中" })).toBeTruthy()
    expect(within(tabs[2]!).getByRole("img", { name: "等待许可" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /关闭 修登录/ })).toBeNull()
  })

  it("selects, closes and moves between tabs with the keyboard", async () => {
    const props = renderTabs()
    await userEvent.click(screen.getByRole("tab", { name: /Codex 子代理/ }))
    expect(props.onSelect).toHaveBeenCalledWith("agent:c1")
    await userEvent.click(screen.getByRole("button", { name: "关闭 梳理入口" }))
    expect(props.onClose).toHaveBeenCalledWith("spawned:s1")
    fireEvent(
      screen.getByRole("tab", { name: /Claude 子代理/ }).parentElement!,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    )
    expect(props.onClose).toHaveBeenCalledWith("agent:c2")
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" })
    expect(props.onSelect).toHaveBeenLastCalledWith("spawned:s1")
  })

  it("has no way to add a tab: sub-agent tabs come from the task itself", () => {
    renderTabs()
    expect(screen.queryByRole("button", { name: /添加/ })).toBeNull()
  })
})

const SPAWN_EVENTS = [
  event(1, "run.started", { text: "并行检查" }),
  event(2, "subagent.started", {
    toolCallId: "task_1",
    name: "Explore",
    description: "梳理入口",
    prompt: "阅读 src/index.ts，列出导出。",
  }),
  event(3, "tool.started", {
    toolCallId: "r1",
    name: "Read",
    input: { file_path: "src/index.ts" },
    parentToolUseId: "task_1",
  }),
  event(4, "tool.completed", {
    toolCallId: "r1",
    name: "Read",
    output: "x",
    isError: false,
    parentToolUseId: "task_1",
  }),
  event(5, "message.completed", {
    role: "assistant",
    text: "只导出 answer。",
    parentToolUseId: "task_1",
  }),
  event(6, "subagent.completed", {
    toolCallId: "task_1",
    isError: false,
    status: "completed",
    output: [{ type: "text", text: "导出：answer。" }],
  }),
  event(7, "message.completed", { role: "assistant", text: "都查完了" }),
  event(8, "run.completed", {}),
]

describe("spawned sub-agents", () => {
  it("parse their task, run and result", () => {
    const subagent = collectSubagents(SPAWN_EVENTS).get("task_1")
    expect(subagent).toMatchObject({
      name: "Explore",
      description: "梳理入口",
      prompt: "阅读 src/index.ts，列出导出。",
      runId: "run_1",
      status: "completed",
      output: "导出：answer。",
    })
    expect(subagent?.events).toHaveLength(3)
  })

  it("render read-only in the chat view with a way back to the main thread", async () => {
    const onBack = vi.fn()
    const subagent = collectSubagents(SPAWN_EVENTS).get("task_1")!
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView events={SPAWN_EVENTS} subagent={subagent} onBackToMain={onBack} />
      </LocaleProvider>,
    )
    expect(screen.getByText("阅读 src/index.ts，列出导出。")).toBeTruthy()
    expect(screen.getByText("只导出 answer。")).toBeTruthy()
    expect(screen.getByText("交回的结果")).toBeTruthy()
    expect(screen.getByText("导出：answer。")).toBeTruthy()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("主 agent 派生的子代理，只读")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "回到主会话" }))
    expect(onBack).toHaveBeenCalled()
  })

  it("open in a tab from their timeline card", async () => {
    const onOpen = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <MessageList events={SPAWN_EVENTS} onApproval={() => {}} onOpenSubagent={onOpen} />
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByRole("button", { name: /已工作|已处理/ }))
    await userEvent.click(screen.getByRole("button", { name: "在标签页中打开 Explore" }))
    expect(onOpen).toHaveBeenCalledWith("task_1")
  })
})

describe("sub-agent threads", () => {
  it("greet with their own text and note the main thread's brief before the first message", () => {
    const events = [
      event(0, "thread.created", { title: "子代理", parentThreadId: "main" }, null),
      event(1, "thread.updated", { handoff: "You are a sub-agent…" }, null),
    ]
    expect(buildTimeline(events)).toEqual([{ kind: "brief", key: "brief-1" }])
    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={{
            id: "c1",
            projectId: "p1",
            title: "Codex 子代理",
            defaultAgentId: "codex",
            defaultInstanceId: null,
            lastAgentId: null,
            lastInstanceId: null,
            lastModelId: null,
            permissionMode: "workspace-write",
            createdAt: "2026-10-21T00:00:00.000Z",
            updatedAt: "2026-10-21T00:00:00.000Z",
            archivedAt: null,
            lastRunId: null,
            parentThreadId: "main",
          }}
          events={events}
          empty={{ title: "和主会话并行工作", hint: "共用工作目录" }}
        />
      </LocaleProvider>,
    )
    expect(screen.getByRole("heading", { level: 1, name: "和主会话并行工作" })).toBeTruthy()
    expect(screen.getByText("共用工作目录")).toBeTruthy()
    expect(screen.getByRole("note").textContent).toBe("已附上主会话的近况")
  })
})
