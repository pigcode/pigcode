/**
 * 验证其余工具行（参照 ZCode 的 mcp / skill / task-output / task-stop / ask-question / switch-mode /
 * fallback）与内置浏览器的操作行、分组。
 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { MessageList } from "../message-list"
import { browserPreview, toolOutputParts, type ToolCall } from "../tool-meta"
import { resetToolOpen } from "../tool-open"
import { ToolBlock } from "./index"

afterEach(() => {
  cleanup()
  resetToolOpen()
})

function inLocale(node: ReactNode) {
  return render(<LocaleProvider locale="zh-CN">{node}</LocaleProvider>)
}

function tool(name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: extra.id ?? `${name}-1`,
    name,
    status: "completed",
    input: JSON.stringify(input),
    inputValue: input,
    output: undefined,
    ...extra,
  }
}

const SHOT = JSON.stringify([
  { type: "image", data: "AAAA", mimeType: "image/jpeg" },
  { type: "text", text: "Screenshot of http://localhost:4173/welcome (1280×800)." },
])

describe("MCP rows", () => {
  it("name the server and tool, show the result and reveal the call's parameters", async () => {
    inLocale(
      <ToolBlock
        tool={tool(
          "mcp__context7__get-library-docs",
          { libraryId: "/react", topic: "hooks" },
          {
            output: JSON.stringify([{ type: "text", text: "useState returns a pair." }]),
          },
        )}
      />,
    )
    const head = screen.getByRole("button", { name: /MCP/ })
    expect(head.textContent).toBe("MCPContext7·Get library docs")
    await userEvent.click(head)
    expect(screen.getByText("useState returns a pair.").className).toBe("mcp-compact")
    await userEvent.click(screen.getByRole("button", { name: "查看调用详情" }))
    expect(screen.getByText(/"libraryId": "\/react"/)).toBeTruthy()
  })

  it("show long or JSON results in a code block with copy and wrap", async () => {
    inLocale(
      <ToolBlock tool={tool("mcp__github__list_issues", {}, { output: '{"issues":[1,2,3]}' })} />,
    )
    await userEvent.click(screen.getByRole("button", { name: /MCP/ }))
    expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "自动换行" }).getAttribute("aria-pressed")).toBe(
      "false",
    )
  })
})

describe("skill, background task and unknown tool rows", () => {
  it("show the skill and its arguments", async () => {
    inLocale(
      <ToolBlock tool={tool("Skill", { skill: "pdf", args: "report.pdf" }, { output: "Done" })} />,
    )
    const head = screen.getByRole("button", { name: /技能/ })
    expect(head.textContent).toContain("pdf")
    expect(head.textContent).toContain("report.pdf")
    await userEvent.click(head)
    expect(screen.getByText("Done")).toBeTruthy()
  })

  it("read background task output and stops", async () => {
    inLocale(
      <>
        <ToolBlock
          tool={tool(
            "BashOutput",
            { bash_id: "bash_1" },
            {
              output: "<status>running</status>\n<stdout>\nwatching…\n</stdout>",
            },
          )}
        />
        <ToolBlock
          tool={tool(
            "KillShell",
            { shell_id: "bash_1" },
            {
              id: "k1",
              output: JSON.stringify({ message: "Successfully killed shell bash_1" }),
            },
          )}
        />
      </>,
    )
    const output = screen.getByRole("button", { name: /任务输出/ })
    expect(output.textContent).toContain("bash_1")
    expect(output.textContent).toContain("任务运行中")
    await userEvent.click(output)
    expect(screen.getByText("watching…")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: /停止任务/ }))
    expect(screen.getByText("Successfully killed shell bash_1")).toBeTruthy()
  })

  it("fall back to the tool name with its parameters and result", async () => {
    inLocale(<ToolBlock tool={tool("frob_widget", { size: 3 }, { output: "frobbed" })} />)
    await userEvent.click(screen.getByRole("button", { name: /Frob widget/ }))
    expect(screen.getByText("调用参数")).toBeTruthy()
    expect(screen.getByText("frobbed")).toBeTruthy()
  })
})

describe("questions and plans", () => {
  it("show an answered AskUserQuestion as a folded history row", async () => {
    inLocale(
      <ToolBlock
        tool={tool(
          "AskUserQuestion",
          { questions: [{ question: "Which OS?" }, { question: "Runner?" }] },
          {
            output: '"Which OS?"="macOS, Linux" "Runner?"="Vitest"',
          },
        )}
      />,
    )
    const head = screen.getByRole("button", { name: /已询问/ })
    expect(head.textContent).toContain("2 个问题")
    await userEvent.click(head)
    expect(screen.getByText("Which OS?")).toBeTruthy()
    expect(screen.getByText("macOS, Linux")).toBeTruthy()
  })

  it("show the plan handed over when leaving plan mode as a card", async () => {
    const long = Array.from({ length: 30 }, (_, index) => `- step ${index + 1}`).join("\n")
    const { container } = inLocale(
      <ToolBlock tool={tool("ExitPlanMode", { plan: `## Plan\n${long}` })} />,
    )
    expect(container.querySelector(".plan-card-title")?.textContent).toBe("计划")
    expect(screen.getByText("Plan")).toBeTruthy()
    expect(screen.getByRole("button", { name: "复制计划" })).toBeTruthy()
  })
})

describe("browser tools", () => {
  it("summarise each action and read screenshots from content blocks", () => {
    const preview = (name: string, input: unknown, output?: string) =>
      browserPreview({ name: `mcp__pigcode__${name}`, input: JSON.stringify(input), output })
    expect(preview("browser_open", { url: "http://localhost:4173/" })).toBe("localhost:4173")
    expect(preview("browser_click", { text: "登录", ref: "e3" })).toBe("登录")
    expect(preview("browser_type", { ref: "e1", text: "demo" })).toBe('"demo" → e1')
    expect(preview("browser_screenshot", {}, SHOT)).toBe("localhost:4173/welcome")
    expect(toolOutputParts(SHOT).images).toEqual(["data:image/jpeg;base64,AAAA"])
    expect(toolOutputParts("plain text")).toEqual({ text: "plain text", images: [] })
  })

  it("open screenshots by default", () => {
    inLocale(
      <ToolBlock
        tool={tool("mcp__pigcode__browser_screenshot", {}, { input: "{}", output: SHOT })}
      />,
    )
    expect(screen.getByRole("button", { name: /截图/ }).getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByRole("img", { name: "截图" }).getAttribute("src")).toBe(
      "data:image/jpeg;base64,AAAA",
    )
  })

  it("fold consecutive steps into one browser row", async () => {
    const event = (seq: number, type: ThreadEvent["type"], payload: unknown): ThreadEvent => ({
      seq,
      threadId: "t1",
      runId: "run_1",
      type,
      payload,
      schemaVersion: 1,
      createdAt: new Date(Date.UTC(2026, 9, 21, 9, 0, seq)).toISOString(),
    })
    const step = (seq: number, id: string, name: string, input: unknown) => [
      event(seq, "tool.started", { id, name: `mcp__pigcode__${name}`, input }),
      event(seq + 1, "tool.completed", { id, name: `mcp__pigcode__${name}`, output: "ok" }),
    ]
    inLocale(
      <MessageList
        events={[
          event(1, "run.started", { text: "check login" }),
          ...step(2, "b1", "browser_open", { url: "http://localhost:4173/" }),
          ...step(4, "b2", "browser_type", { ref: "e1", text: "demo" }),
          ...step(6, "b3", "browser_click", { ref: "e3" }),
          event(8, "message.completed", { role: "assistant", text: "登录正常" }),
          event(9, "run.completed", {}),
        ]}
        onApproval={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole("button", { name: /已工作/ }))
    const group = screen.getByRole("button", { name: /浏览器.*localhost:4173 · 3 步/ })
    await userEvent.click(group)
    expect(screen.getByText("打开网页")).toBeTruthy()
    expect(screen.getByText('"demo" → e1')).toBeTruthy()
    expect(screen.getByText("点击")).toBeTruthy()
  })
})
