/** 验证按轮整理时间线（参照 ZCode 的 turn render unit）与一轮的渲染：折叠头、工作区与最终回答。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { MessageList } from "./message-list"
import { resetToolOpen } from "./tool-open"
import { formatDuration } from "./turn-view"
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
    e(2, "run.started", { providerId: "claude" }, 0),
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
    expect(turn?.work.map((item) => item.kind)).toEqual([
      "reasoning",
      "message",
      "explore",
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
    expect(names).toEqual(["Edit", "Bash"])
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
        event(30, "thread.updated", { providerId: "codex", handoff: "summary" }, null),
      ],
      true,
    )
    expect(entries.map((entry) => entry.kind)).toEqual(["turn", "switch", "turn"])
    expect(entries[1]).toMatchObject({ agentId: "codex", handoff: true })
    expect(entries[2]?.kind === "turn" ? entries[2].turn.status : null).toBe("running")
  })

  it("keeps a turn's signature until one of its own events changes", () => {
    const first = scriptedRun("run_1")
    const before = onlyTurns([...first, ...scriptedRun("run_2", 100).slice(0, 5)])
    const after = onlyTurns([...first, ...scriptedRun("run_2", 100).slice(0, 7)])
    expect(after[0]?.signature).toBe(before[0]?.signature)
    expect(after[1]?.signature).not.toBe(before[1]?.signature)
  })
})

describe("formatDuration", () => {
  it("rounds to seconds and keeps the two largest units", () => {
    expect(formatDuration(400, "zh-CN")).toBe("1 秒")
    expect(formatDuration(12_000, "zh-CN")).toBe("12 秒")
    expect(formatDuration(185_000, "zh-CN")).toBe("3 分 5 秒")
    expect(formatDuration(3_605_000, "zh-CN")).toBe("1 时 5 秒")
    expect(formatDuration(93_784_000, "zh-CN")).toBe("1 天 2 时")
    expect(formatDuration(3_720_000, "en-US")).toBe("1h 2m")
  })
})

describe("turn rendering", () => {
  function renderList(events: ThreadEvent[], streamingText = "", liveReasoning = "") {
    return render(
      <LocaleProvider locale="zh-CN">
        <MessageList
          events={events}
          streamingText={streamingText}
          liveReasoning={liveReasoning}
          root="/repo"
          onApproval={() => {}}
        />
      </LocaleProvider>,
    )
  }

  it("folds a finished turn's work under 'worked for' and shows the files it changed", async () => {
    const { container } = renderList(scriptedRun())
    expect(container.querySelector(".msg-user")?.textContent).toBe("fix the answer")
    expect(screen.getByText("Fixed it.").closest(".msg-ai")).not.toBeNull()
    expect(screen.queryByText("Looking around.")).toBeNull()
    expect(screen.getByRole("button", { name: "展开已更改文件" }).textContent).toBe(
      "1 个文件已更改+1 -1",
    )
    const header = screen.getByRole("button", { name: "已工作 12 秒" })
    expect(header.getAttribute("aria-expanded")).toBe("false")
    await userEvent.click(header)
    expect(header.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Looking around.")).toBeTruthy()
    expect(screen.getByRole("button", { name: /思考/ }).textContent).toBe("思考·持续了 3 秒")
    expect(screen.getByRole("button", { name: /查阅/ }).textContent).toBe("查阅·2 文件, 1 搜索")
    expect(screen.getByRole("button", { name: /终端/ }).textContent).toContain("pnpm test")
  })

  it("keeps the work open without a chevron while running and streams the answer below it", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 21, 8, 0, 9)))
    const { container } = renderList(scriptedRun().slice(0, 14), "partial answer", "Checking the")
    const header = screen.getByRole("button", { name: "工作中 9 秒" })
    expect(header.hasAttribute("disabled")).toBe(true)
    expect(header.querySelector(".work-chev")).toBeNull()
    expect(screen.getByText("Looking around.")).toBeTruthy()
    expect(screen.getByText("partial answer").closest(".msg-ai")?.className).toContain(
      "is-streaming",
    )
    expect(container.querySelector(".reasoning-row .tool-shimmer")?.textContent).toBe("正在思考")
    expect(container.querySelector(".reasoning-peek")?.textContent).toBe("Checking the")
    expect(container.querySelector(".turn-loading")).not.toBeNull()
  })

  it("keeps the work open when a turn fails or is stopped, or ends without an answer", () => {
    const failed = [
      event(1, "run.started", { text: "go" }),
      event(2, "tool.started", { id: "b1", name: "Bash", input: { command: "make" } }),
      event(3, "tool.completed", { id: "b1", name: "Bash", output: "boom", isError: true }),
      event(4, "run.failed", { message: "provider crashed" }),
    ]
    renderList(failed)
    expect(screen.getByRole("alert").textContent).toBe("provider crashed")
    expect(screen.getByRole("button", { name: /终端/ })).toBeTruthy()
    cleanup()
    renderList([
      event(1, "run.started", { text: "go" }),
      event(2, "tool.started", { id: "b1", name: "Bash", input: { command: "make" } }),
      event(3, "run.interrupted", {}),
    ])
    expect(screen.getByRole("button", { name: "已停止" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: /终端/ })).toBeTruthy()
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
    renderList(asking)
    expect(screen.getByRole("button", { name: "等待回答" })).toBeTruthy()
    expect(screen.getByRole("form", { name: "Agent 想先确认几件事" })).toBeTruthy()
    expect(screen.getByText("正在询问").className).toContain("tool-shimmer")
    cleanup()
    renderList([
      ...asking,
      event(3, "question.answered", { id: "q1", answers: ["Linux"] }),
      event(4, "message.completed", { role: "assistant", text: "Linux it is." }),
      event(5, "run.completed", {}),
    ])
    expect(screen.queryByRole("form")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /已工作/ }))
    await userEvent.click(screen.getByRole("button", { name: /已询问/ }))
    expect(screen.getByText("Linux")).toBeTruthy()
  })

  it("draws a marker divider when the agent changes", () => {
    renderList([...scriptedRun(), event(30, "thread.updated", { providerId: "codex" }, null)])
    expect(screen.getByRole("separator").textContent).toBe("已切换到 codex")
  })
})
