/** 验证提问卡片：单选与多选、补充「其他」、答完才能提交；时间线显示「等待回答」。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MessageList } from "./message-list"
import { QuestionCard, type QuestionRequestView } from "./question-card"

afterEach(cleanup)

const REQUEST: QuestionRequestView = {
  id: "q_1",
  questions: [
    {
      question: "这次改动要覆盖哪些平台？",
      header: "平台",
      options: [{ label: "macOS" }, { label: "Windows" }, { label: "Linux" }],
      multiSelect: true,
    },
    {
      question: "测试用哪个框架？",
      options: [{ label: "Vitest", description: "和项目现有配置一致" }, { label: "Jest" }],
      multiSelect: false,
    },
  ],
}

describe("QuestionCard", () => {
  it("collects one answer per question before it can be sent", async () => {
    const onAnswer = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <QuestionCard request={REQUEST} onAnswer={onAnswer} />
      </LocaleProvider>,
    )
    const submit = screen.getByRole("button", { name: "提交回答" })
    expect(submit.hasAttribute("disabled")).toBe(true)
    await userEvent.click(screen.getByRole("checkbox", { name: "macOS" }))
    await userEvent.click(screen.getByRole("checkbox", { name: "Linux" }))
    await userEvent.click(screen.getByRole("checkbox", { name: "macOS" }))
    await userEvent.type(
      screen.getByRole("textbox", { name: "这次改动要覆盖哪些平台？ 其他（自己填写）" }),
      "FreeBSD",
    )
    expect(submit.hasAttribute("disabled")).toBe(true)
    await userEvent.click(screen.getByRole("radio", { name: /Vitest/ }))
    await userEvent.click(screen.getByRole("radio", { name: /Jest/ }))
    await userEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith("q_1", ["Linux, FreeBSD", "Jest"])
  })

  it("replaces a single choice with typed text", async () => {
    const onAnswer = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <QuestionCard request={REQUEST} onAnswer={onAnswer} />
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByRole("checkbox", { name: "Windows" }))
    await userEvent.click(screen.getByRole("radio", { name: /Vitest/ }))
    await userEvent.type(
      screen.getByRole("textbox", { name: "测试用哪个框架？ 其他（自己填写）" }),
      "node:test",
    )
    expect((screen.getByRole("radio", { name: /Vitest/ }) as HTMLInputElement).checked).toBe(false)
    await userEvent.click(screen.getByRole("button", { name: "提交回答" }))
    expect(onAnswer).toHaveBeenCalledWith("q_1", ["Windows", "node:test"])
  })

  it("shows a plan from plan mode as the plan itself, with start or keep planning", async () => {
    const onApproval = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <MessageList
          events={[
            {
              seq: 1,
              threadId: "t1",
              runId: "run_1",
              type: "approval.requested",
              payload: {
                id: "req_1",
                toolName: "ExitPlanMode",
                input: { plan: "## 计划\n\n1. 改 `answer`\n2. 跑测试" },
              },
              schemaVersion: 1,
              createdAt: "2026-10-21T00:00:00.000Z",
            },
          ]}
          onApproval={onApproval}
        />
      </LocaleProvider>,
    )
    const card = screen.getByRole("group", { name: "计划写好了，开始执行？" })
    expect(card.textContent).toContain("跑测试")
    expect(screen.queryByRole("button", { name: "本次会话允许" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "继续完善" }))
    expect(onApproval).toHaveBeenCalledWith("req_1", "deny")
    await userEvent.click(screen.getByRole("button", { name: "开始执行" }))
    expect(onApproval).toHaveBeenLastCalledWith("req_1", "allow-once")
  })

  it("puts the turn in 'waiting for your answer' until it is answered", () => {
    const event = (seq: number, type: ThreadEvent["type"], payload: unknown): ThreadEvent => ({
      seq,
      threadId: "t1",
      runId: "run_1",
      type,
      payload,
      schemaVersion: 1,
      createdAt: "2026-10-21T00:00:00.000Z",
    })
    render(
      <LocaleProvider locale="zh-CN">
        <MessageList
          events={[
            event(1, "run.started", { text: "ask" }),
            event(2, "question.requested", { id: "q_1", questions: REQUEST.questions }),
          ]}
          onApproval={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByRole("button", { name: /等待回答/ })).toBeTruthy()
    expect(screen.getByRole("form", { name: "Agent 想先确认几件事" })).toBeTruthy()
  })
})
