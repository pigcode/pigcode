/** 验证工作流卡片：快照合并、一行摘要的进度、按阶段列出 agent、点开看结论与脚本，以及一轮结束后的收尾。 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent, WorkflowAgent, WorkflowSnapshot } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { resetToolOpen } from "./tool-open"
import { buildTimeline, type Turn } from "./turns"
import { WorkflowRow, collectWorkflows, type WorkflowCall } from "./workflow-card"

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
    createdAt: "2026-11-10T00:00:00.000Z",
  }
}

const PHASES = [
  { index: 1, title: "检查文件" },
  { index: 2, title: "汇总" },
]

function agent(index: number, label: string, patch: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return { index, label, phase: index < 3 ? "检查文件" : "汇总", state: "running", ...patch }
}

function snapshot(seq: number, patch: Partial<WorkflowSnapshot>): ThreadEvent {
  return event(seq, "workflow.updated", {
    toolCallId: "wf_1",
    name: "audit-exports",
    description: "逐个文件检查导出",
    status: "running",
    phases: PHASES,
    agents: [],
    ...patch,
  })
}

const STARTED = snapshot(2, { phases: [], script: "export const meta = { name: 'audit-exports' }" })
const RUNNING = snapshot(3, {
  agents: [
    agent(1, "check:index.ts", {
      state: "done",
      result: "导出 answer",
      durationMs: 8200,
      tokens: 31200,
    }),
    agent(2, "check:math.ts", { activity: "Read src/math.ts", prompt: "读 src/math.ts" }),
    agent(3, "summary", { state: "queued" }),
  ],
})
const DONE = snapshot(4, {
  status: "completed",
  agents: [
    agent(1, "check:index.ts", { state: "done", result: "导出 answer", durationMs: 8200 }),
    agent(2, "check:math.ts", {
      state: "done",
      result: "导出 add，没有校验参数",
      durationMs: 11400,
    }),
    agent(3, "summary", { state: "done", result: "共导出 answer 与 add", durationMs: 6100 }),
  ],
  usage: { tokens: 107300, durationMs: 23800 },
})

function renderRow(workflow: WorkflowCall) {
  return render(
    <LocaleProvider locale="zh-CN">
      <WorkflowRow workflow={workflow} />
    </LocaleProvider>,
  )
}

/** 一行摘要（展开后卡片里还有「工作流脚本」按钮，不能按名字找）。 */
function rowHead(): HTMLElement {
  const head = document.querySelector<HTMLElement>(".workflow-row .tool-row-head")
  if (!head) throw new Error("no workflow row")
  return head
}

function workflowOf(events: ThreadEvent[]): WorkflowCall {
  const workflow = collectWorkflows(events).get("wf_1")
  if (!workflow) throw new Error("no workflow")
  return workflow
}

describe("workflow card", () => {
  it("merges snapshots: later fields win and the script from the first one stays", () => {
    const workflow = workflowOf([DONE, STARTED, RUNNING])
    expect(workflow.status).toBe("completed")
    expect(workflow.script).toContain("audit-exports")
    expect(workflow.agents.map((item) => item.state)).toEqual(["done", "done", "done"])
    expect(workflow.usage).toEqual({ tokens: 107300, durationMs: 23800 })
  })

  it("shows the running phase and progress on the row and opens itself while running", () => {
    renderRow(workflowOf([STARTED, RUNNING]))
    const head = rowHead()
    expect(head.textContent).toContain("audit-exports")
    expect(head.textContent).toContain("检查文件 · 1/3 完成")
    expect(document.querySelectorAll(".workflow-pip")).toHaveLength(3)
    // 运行中自动展开：按阶段列出 agent，运行中的显示它在做的事。
    const phases = document.querySelectorAll(".workflow-phase")
    expect(
      [...phases].map((phase) => phase.querySelector(".workflow-phase-title")?.textContent),
    ).toEqual(["检查文件", "汇总"])
    expect(screen.getByText("Read src/math.ts")).toBeTruthy()
    expect(screen.getByText("导出 answer")).toBeTruthy()
    expect(screen.getAllByText("1/2")).toHaveLength(1)
  })

  it("opens an agent to read its task and result, and shows the script on request", async () => {
    renderRow(workflowOf([STARTED, RUNNING]))
    const line = screen.getByText("check:math.ts").closest("button") as HTMLButtonElement
    await userEvent.click(line)
    const body = line.parentElement?.querySelector(".workflow-agent-body") as HTMLElement
    expect(within(body).getByText("读 src/math.ts")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "工作流脚本" }))
    expect(document.querySelector(".workflow-script-code")?.textContent).toContain(
      "export const meta",
    )
  })

  it("summarises a finished workflow with its description and total usage", async () => {
    renderRow(workflowOf([STARTED, DONE]))
    const head = rowHead()
    expect(head.textContent).toContain("逐个文件检查导出")
    expect(head.textContent).not.toContain("完成 ·")
    await userEvent.click(head)
    expect(screen.getByText("24 秒 · 107.3k tokens")).toBeTruthy()
  })

  it("places the card where the workflow started and stops it when the turn ends early", () => {
    const events = [
      event(1, "message.completed", { role: "assistant", text: "开始检查" }),
      STARTED,
      event(5, "message.completed", { role: "assistant", text: "已经启动" }),
      RUNNING,
      event(6, "run.interrupted", {}),
    ]
    const turn = buildTimeline(events).flatMap((entry): Turn[] =>
      entry.kind === "turn" ? [entry.turn] : [],
    )[0]
    const kinds = turn?.work.map((item) => item.kind)
    expect(kinds?.filter((kind) => kind === "workflow")).toHaveLength(1)
    // 卡片排在启动它之前的那段话后面；之后的快照只更新同一张卡片。
    expect(kinds?.slice(0, 2)).toEqual(["message", "workflow"])
    const card = turn?.work.find((item) => item.kind === "workflow")
    expect(card?.kind === "workflow" && card.workflow.status).toBe("stopped")
  })
})
