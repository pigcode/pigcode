/** 验证按轮整理时间线（参照 ZCode 的 turn render unit）与一轮的渲染：折叠头、工作区与最终回答。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { MessageList } from "./message-list"
import { resetToolOpen } from "./tool-open"
import { WithToolRenderers } from "./tools/tool-renderers.fixtures"
import { buildTimeline, latestPlan, type Turn } from "./turns"

afterEach(() => {
  cleanup()
  resetToolOpen()
  vi.useRealTimers()
})

function event(
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown = {},
  runId: string | null = "run_1",
  at = seq,
): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 9, 21, 8, 0, at)).toISOString(),
  }
}

/** 一轮完整的脚本：思考、说明、两个读文件、一个搜索、待办、一个编辑、一个命令、回答。 */
function scriptedRun(runId = "run_1", base = 0): ThreadEvent[] {
  const e = (seq: number, type: ThreadEvent["type"], payload: unknown, at: number) =>
    event(seq + base, type, payload, runId, at)
  const todos = [
    { content: "Read the code", status: "completed" },
    { content: "Fix the answer", status: "in_progress" },
  ]
  return [
    e(1, "message.completed", { role: "user", text: "fix the answer" }, 0),
    e(2, "run.started", { agentId: "claude" }, 0),
    e(3, "reasoning.completed", { text: "Need to find the constant.", durationMs: 2100 }, 1),
    e(4, "message.completed", { role: "assistant", text: "Looking around." }, 1),
    e(5, "tool.started", { id: "r1", name: "Read", input: { file_path: "/repo/README.md" } }, 2),
    e(6, "tool.completed", { id: "r1", name: "Read", output: "# Demo" }, 3),
    e(7, "tool.started", { id: "r2", name: "Read", input: { file_path: "/repo/src/index.ts" } }, 4),
    e(8, "tool.completed", { id: "r2", name: "Read", output: "export" }, 5),
    e(9, "tool.started", { id: "g1", name: "Grep", input: { pattern: "answer" } }, 6),
    e(10, "tool.completed", { id: "g1", name: "Grep", output: "src/index.ts:1" }, 6),
    e(11, "tool.started", { id: "t1", name: "TodoWrite", input: { todos } }, 6),
    e(12, "tool.completed", { id: "t1", name: "TodoWrite", output: "ok" }, 6),
    e(
      13,
      "tool.started",
      {
        id: "w1",
        name: "Edit",
        input: { file_path: "/repo/src/index.ts", old_string: "41", new_string: "42" },
      },
      7,
    ),
    e(14, "tool.completed", { id: "w1", name: "Edit", output: "ok" }, 7),
    e(15, "tool.started", { id: "b1", name: "Bash", input: { command: "pnpm test" } }, 8),
    e(16, "tool.completed", { id: "b1", name: "Bash", output: "ok" }, 9),
    e(17, "message.completed", { role: "assistant", text: "Fixed it." }, 10),
    e(18, "run.completed", {}, 12),
  ]
}

function onlyTurns(events: ThreadEvent[], streaming = false): Turn[] {
  return buildTimeline(events, streaming).flatMap((entry) =>
    entry.kind === "turn" ? [entry.turn] : [],
  )
}

describe("buildTimeline", () => {
  it("splits a finished run into user text, folded work, the final answer and changed files", () => {
    const [turn] = onlyTurns(scriptedRun())
    expect(turn).toMatchObject({
      runId: "run_1",
      userText: "fix the answer",
      agentId: "claude",
      status: "completed",
      answer: "Fixed it.",
      replyText: "Looking around.\n\nFixed it.",
    })
    // 工作是平铺的一列，连续的摘要在渲染时才合成一组。
    expect(turn?.work.map((item) => item.kind)).toEqual([
      "reasoning",
      "message",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
    ])
    expect(turn?.work[0]).toMatchObject({ text: "Need to find the constant.", durationMs: 2100 })
    expect(turn?.files).toEqual([
      expect.objectContaining({ path: "/repo/src/index.ts", added: 1, removed: 1 }),
    ])
  })

  it("keeps todos out of the stream and remembers the latest list", () => {
    const timeline = buildTimeline(scriptedRun())
    const [turn] = onlyTurns(scriptedRun())
    const names = turn?.work.flatMap((item) => (item.kind === "tool" ? [item.tool.name] : []))
    expect(names).toEqual(["Read", "Read", "Grep", "Edit", "Bash"])
    expect(latestPlan(timeline)).toEqual([
      { text: "Read the code", status: "completed" },
      { text: "Fix the answer", status: "in-progress" },
    ])
  })

  it("keeps every message as work while the run is still going", () => {
    const [turn] = onlyTurns(scriptedRun().slice(0, 9))
    expect(turn?.status).toBe("running")
    expect(turn?.answer).toBeNull()
    expect(turn?.work[1]).toMatchObject({ kind: "message", text: "Looking around." })
  })

  it("keeps only pending approvals and marks the turn as waiting", () => {
    const events = [
      event(1, "run.started", { text: "deploy" }),
      event(2, "approval.requested", { id: "req_1", title: "Run deploy", command: "./deploy.sh" }),
    ]
    const [waiting] = onlyTurns(events)
    expect(waiting?.status).toBe("waiting")
    expect(waiting?.approvals).toEqual([expect.objectContaining({ id: "req_1" })])
    const [resolved] = onlyTurns([
      ...events,
      event(3, "approval.resolved", { id: "req_1", decision: "deny" }),
    ])
    expect(resolved?.status).toBe("running")
    expect(resolved?.approvals).toEqual([])
  })

  it("turns questions into work items and drops the duplicate AskUserQuestion row", () => {
    const question = {
      id: "q1",
      questions: [{ question: "Which OS?", options: [{ label: "macOS" }] }],
    }
    const events = [
      event(1, "run.started", { text: "ask" }),
      event(2, "tool.started", { id: "ask1", name: "AskUserQuestion", input: question }),
      event(3, "question.requested", question),
    ]
    const [asking] = onlyTurns(events)
    expect(asking?.status).toBe("waiting")
    expect(asking?.work.map((item) => item.kind)).toEqual(["question"])
    const [answered] = onlyTurns([
      ...events,
      event(4, "question.answered", { id: "q1", answers: ["macOS"] }),
      event(5, "message.completed", { role: "assistant", text: "ok" }),
      event(6, "run.completed", {}),
    ])
    expect(answered?.work[0]).toMatchObject({ kind: "question", answers: ["macOS"] })
  })

  it("adds a divider when the thread switches agents and a running turn for orphan streaming", () => {
    const entries = buildTimeline(
      [
        ...scriptedRun(),
        event(30, "thread.updated", { agentId: "codex", handoff: "summary" }, null),
      ],
      true,
    )
    expect(entries.map((entry) => entry.kind)).toEqual(["turn", "switch", "turn"])
    expect(entries[1]).toMatchObject({
      agentId: "codex",
      handoff: true,
      resumed: false,
      items: null,
    })
    expect(entries[2]?.kind === "turn" ? entries[2].turn.status : null).toBe("running")
  })

  it("keeps a turn's signature until one of its own events changes", () => {
    const first = scriptedRun("run_1")
    const before = onlyTurns([...first, ...scriptedRun("run_2", 100).slice(0, 5)])
    const after = onlyTurns([...first, ...scriptedRun("run_2", 100).slice(0, 7)])
    expect(after[0]?.signature).toBe(before[0]?.signature)
    expect(after[1]?.signature).not.toBe(before[1]?.signature)
  })

  it("marks only the running tool associated with a pending approval and clears it when resolved or ended", () => {
    // 1. 优先按 toolCallId / callId 精确匹配运行中工具
    const byIdEvents = [
      event(1, "run.started", { text: "deploy" }),
      event(2, "tool.started", { id: "b1", name: "Bash", input: { command: "echo 1" } }),
      event(3, "tool.started", { id: "b2", name: "Bash", input: { command: "rm -rf dist" } }),
      event(4, "approval.requested", {
        id: "req_1",
        callId: "b1",
        toolName: "Bash",
        command: "echo 1",
      }),
    ]
    const [byIdTurn] = onlyTurns(byIdEvents)
    expect(byIdTurn?.approvals[0]).toMatchObject({
      id: "req_1",
      toolCallId: "b1",
      toolName: "Bash",
    })
    expect(byIdTurn?.work).toMatchObject([
      { kind: "tool", tool: { id: "b1", pendingApproval: true } },
      { kind: "tool", tool: { id: "b2" } },
    ])
    expect(
      byIdTurn?.work[1]?.kind === "tool" ? byIdTurn.work[1].tool.pendingApproval : undefined,
    ).toBeUndefined()

    // 2. 缺 toolCallId 时按 toolName / name 匹配最后一个同工具名运行中工具
    const byNameEvents = [
      event(1, "run.started", { text: "deploy" }),
      event(2, "tool.started", { id: "r1", name: "Read", input: { file_path: "a.ts" } }),
      event(3, "tool.completed", { id: "r1", name: "Read", output: "ok" }),
      event(4, "tool.started", { id: "b1", name: "Bash", input: { command: "echo 1" } }),
      event(5, "tool.started", { id: "b2", name: "Bash", input: { command: "rm -rf dist" } }),
      event(6, "approval.requested", { id: "req_2", name: "Bash", command: "rm -rf dist" }),
    ]
    const [byNameTurn] = onlyTurns(byNameEvents)
    expect(byNameTurn?.work[2]).toMatchObject({
      kind: "tool",
      tool: { id: "b2", pendingApproval: true },
    })
    expect(
      byNameTurn?.work[1]?.kind === "tool" ? byNameTurn.work[1].tool.pendingApproval : undefined,
    ).toBeUndefined()

    // 3. 既无 toolCallId 也无 toolName 且当前仅有唯一运行中工具时也可关联
    const soleRunningEvents = [
      event(1, "run.started", { text: "deploy" }),
      event(2, "tool.started", { id: "r1", name: "Read", input: { file_path: "a.ts" } }),
      event(3, "tool.completed", { id: "r1", name: "Read", output: "ok" }),
      event(4, "tool.started", { id: "b1", name: "Bash", input: { command: "./deploy.sh" } }),
      event(5, "approval.requested", { id: "req_3", title: "Run deploy", command: "./deploy.sh" }),
    ]
    const [soleTurn] = onlyTurns(soleRunningEvents)
    expect(soleTurn?.work[1]).toMatchObject({
      kind: "tool",
      tool: { id: "b1", pendingApproval: true },
    })

    // 4. 审批决议后 pendingApproval 清除；本轮结束后也清除
    const [resolvedTurn] = onlyTurns([
      ...soleRunningEvents,
      event(6, "approval.resolved", { id: "req_3", decision: "allow-once" }),
    ])
    expect(
      resolvedTurn?.work[1]?.kind === "tool"
        ? resolvedTurn.work[1].tool.pendingApproval
        : undefined,
    ).toBeUndefined()

    const [endedTurn] = onlyTurns([...soleRunningEvents, event(6, "run.interrupted", {})])
    expect(
      endedTurn?.work[1]?.kind === "tool" ? endedTurn.work[1].tool.pendingApproval : undefined,
    ).toBeUndefined()
  })
})

describe("turn rendering", () => {
  function renderList(events: ThreadEvent[], streamingText = "", liveReasoning = "") {
    return render(
      <LocaleProvider locale="zh-CN">
        <WithToolRenderers>
          <MessageList
            events={events}
            streamingText={streamingText}
            liveReasoning={liveReasoning}
            root="/repo"
            onApproval={() => {}}
          />
        </WithToolRenderers>
      </LocaleProvider>,
    )
  }

  it("shows when the user sent the message even if the run started later", () => {
    const sent = event(1, "message.completed", { role: "user", text: "Check this" }, "run_1", 0)
    const { container } = renderList([
      sent,
      event(2, "run.queued", {}, "run_1", 1),
      event(3, "run.started", { text: "Check this" }, "run_1", 120),
      event(4, "message.completed", { role: "assistant", text: "Done" }, "run_1", 125),
      event(5, "run.completed", {}, "run_1", 125),
    ])
    const timestamp = container.querySelector(".turn-user-actions time")
    expect(timestamp?.getAttribute("datetime")).toBe(sent.createdAt)
    expect(timestamp?.textContent).toBeTruthy()
  })

  it("folds a finished turn's work under 'worked for' and shows the files it changed", async () => {
    const { container } = renderList(scriptedRun())
    expect(container.querySelector(".msg-user")?.textContent).toBe("fix the answer")
    expect(screen.getByText("Fixed it.").closest(".msg-ai")).not.toBeNull()
    expect(screen.queryByText("Looking around.")).toBeNull()
    expect(screen.getByRole("button", { name: "展开改动" }).textContent).toBe("改了 1 个文件+1 -1")
    const header = screen.getByRole("button", { name: "用时 12 秒" })
    expect(header.getAttribute("aria-expanded")).toBe("false")
    await userEvent.click(header)
    expect(header.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Looking around.")).toBeTruthy()
    expect(screen.getByRole("button", { name: /思考/ }).textContent).toBe("思考持续了 3 秒")
    // 两次读取、一次搜索、一次编辑和一条命令连成一组，结束后显示统计。
    const group = screen.getByRole("button", { name: "已查阅 3 项，已执行 1 命令，已修改 1 文件" })
    expect(group.textContent).toBe("已查阅 3 项，已执行 1 命令，已修改 1 文件")
    await userEvent.click(group)
    expect(screen.getByRole("button", { name: /^已执行/ }).textContent).toContain("pnpm test")
  })

  it("keeps the work open while running, previews the newest item and streams the answer below", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 21, 8, 0, 9)))
    const { container } = renderList(scriptedRun().slice(0, 14), "", "Checking the")
    // 运行中没有折叠头，工作一直展开，末尾一行「工作中」和计时。
    expect(container.querySelector(".work-head")).toBeNull()
    expect(screen.getByText("Looking around.")).toBeTruthy()
    expect(screen.getByRole("status", { name: "工作中" }).textContent).toBe("工作中9 秒")
    // 末尾的摘要组还没闭合：组头就是正在输出的思考，动作扫光，后面跟着最新的一句。
    const group = container.querySelector(".summary-group[data-running]")!
    expect(group.querySelector(".summary-group-preview .tool-shimmer")?.textContent).toBe(
      "正在思考",
    )
    expect(group.querySelector(".reasoning-peek")?.textContent).toBe("Checking the")
    cleanup()
    const streaming = renderList(scriptedRun().slice(0, 14), "partial answer")
    // 开始写回答以后，前面的组闭合，换成统计；回答在工作下面流出来。
    expect(screen.getByRole("button", { name: "已查阅 3 项，已修改 1 文件" })).toBeTruthy()
    expect(screen.getByText("partial answer").closest(".msg-ai")?.className).toContain(
      "is-streaming",
    )
    expect(streaming.container.querySelector(".turn-loading")).not.toBeNull()
  })

  it("keeps the work open when a turn fails or is stopped, or ends without an answer", () => {
    const failed = [
      event(1, "run.started", { text: "go" }),
      event(2, "tool.started", { id: "b1", name: "Bash", input: { command: "make" } }),
      event(3, "tool.completed", { id: "b1", name: "Bash", output: "boom", isError: true }),
      event(4, "run.failed", { message: "agent crashed" }),
    ]
    renderList(failed)
    expect(screen.getByRole("alert").textContent).toBe("agent crashed")
    expect(screen.getByRole("button", { name: /已执行/ })).toBeTruthy()
    cleanup()
    renderList([
      event(1, "run.started", { text: "go" }),
      event(2, "tool.started", { id: "b1", name: "Bash", input: { command: "make" } }),
      event(3, "run.interrupted", {}),
    ])
    expect(screen.getByRole("button", { name: "已停止" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: /已执行/ })).toBeTruthy()
  })

  it("asks inline while waiting and keeps an answered question as a history row", async () => {
    const question = {
      id: "q1",
      questions: [{ question: "Which OS?", options: [{ label: "macOS" }, { label: "Linux" }] }],
    }
    const asking = [
      event(1, "run.started", { text: "ask" }),
      event(2, "question.requested", question),
    ]
    const { container } = renderList(asking)
    // 等用户回答时没有折叠头，也不显示「工作中」，由提问卡片说明在等什么。
    expect(container.querySelector(".work-head")).toBeNull()
    expect(container.querySelector(".turn-loading")).toBeNull()
    expect(screen.getByRole("form", { name: "Agent 想问你几件事" })).toBeTruthy()
    expect(screen.getByText("正在提问").className).toContain("tool-shimmer")
    cleanup()
    renderList([
      ...asking,
      event(3, "question.answered", { id: "q1", answers: ["Linux"] }),
      event(4, "message.completed", { role: "assistant", text: "Linux it is." }),
      event(5, "run.completed", {}),
    ])
    expect(screen.queryByRole("form")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /^用时/ }))
    await userEvent.click(screen.getByRole("button", { name: /问过了/ }))
    expect(screen.getByText("Linux")).toBeTruthy()
  })

  it("keeps a notice on the turn outside the folded work", () => {
    const events = [
      ...scriptedRun(),
      event(19, "notice", {
        level: "warning",
        key: "mcp.bridge.failed",
        params: { name: "pigcode" },
      }),
    ]
    const [turn] = onlyTurns(events)
    expect(turn?.notices).toEqual([
      { id: "notice-19", level: "warning", key: "mcp.bridge.failed", params: { name: "pigcode" } },
    ])
    // 提示不进工作区：工作区结束时会折叠起来。
    expect(turn?.work.some((item) => item.kind === "message")).toBe(true)
    renderList(events)
    expect(screen.getByRole("status").textContent).toContain("插件工具没连上")
    expect(screen.getByRole("status").getAttribute("data-level")).toBe("warning")
  })

  it("explains an interrupted turn when the notice has no params", () => {
    // Host 重启后补的那条（monorepo#6 的缺口 B）：没有占位参数，文案原样显示。
    const events = [
      ...scriptedRun(),
      event(19, "notice", { level: "warning", key: "host.restarted" }),
    ]
    const [turn] = onlyTurns(events)
    expect(turn?.notices[0]).toMatchObject({ key: "host.restarted", params: {} })
    renderList(events)
    expect(screen.getByRole("status").textContent).toContain("Pigcode 重启过")
  })

  it("draws a marker divider when the agent changes", () => {
    renderList([...scriptedRun(), event(30, "thread.updated", { agentId: "codex" }, null)])
    expect(screen.getByRole("separator").textContent).toBe("换成了 codex")
  })

  it.each([
    [{ resumed: true }, "换成了 codex · 接回原来的会话"],
    [
      { resumed: true, handoffId: "h", handoffItems: 3, handoffOmitted: 0 },
      "换成了 codex · 接回原来的会话，补上离开后的 3 条",
    ],
    [
      { handoffId: "h", handoffItems: 12, handoffOmitted: 0 },
      "换成了 codex · 开了新会话，带上了 12 条",
    ],
    [
      { handoffId: "h", handoffItems: 12, handoffOmitted: 40 },
      "换成了 codex · 开了新会话，带上了 12 条，省掉 40 条",
    ],
    [{ handoff: "old text" }, "换成了 codex · 把之前的内容总结后交给它"],
  ])("says how the context carried over: %j", (payload, text) => {
    renderList([
      ...scriptedRun(),
      event(30, "thread.updated", { agentId: "codex", ...payload }, null),
    ])
    expect(screen.getByRole("separator").textContent).toBe(text)
  })
})
