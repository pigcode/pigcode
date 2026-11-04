/** 验证终端命令、读写文件、搜索与查阅分组的工具行（参照 ZCode 的 execute / read / edit / search）。 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { MessageList } from "../message-list"
import { commandText, type ToolCall } from "../tool-meta"
import { resetToolOpen } from "../tool-open"
import { ConversationActionsContext, type ConversationActions } from "./common"
import { ToolBlock } from "./index"
import { plainOutput } from "./shell"
import { WithToolRenderers } from "./tool-renderers.fixtures"

afterEach(() => {
  cleanup()
  resetToolOpen()
})

function inLocale(node: ReactNode, actions: ConversationActions = {}) {
  return render(
    <LocaleProvider locale="zh-CN">
      <ConversationActionsContext.Provider value={actions}>
        <WithToolRenderers>{node}</WithToolRenderers>
      </ConversationActionsContext.Provider>
    </LocaleProvider>,
  )
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

function e(seq: number, type: ThreadEvent["type"], payload: unknown): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId: "run_1",
    type,
    payload,
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 9, 21, 8, 0, seq)).toISOString(),
  }
}

describe("command rows", () => {
  it("shimmer while running without opening, and follow the live output once opened", async () => {
    const running = tool("Bash", { command: "bash -lc 'pnpm test'" }, { status: "running" })
    const { container } = inLocale(<ToolBlock tool={running} live={"✓ a\n✓ b\n"} />)
    const head = screen.getByRole("button", { name: /正在执行/ })
    expect(head.getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector(".tool-shimmer")?.textContent).toBe("正在执行")
    expect(head.textContent).toContain("pnpm test")
    await userEvent.click(head)
    expect(screen.getByLabelText("输出").textContent).toBe("✓ a\n✓ b")
    expect(container.querySelector(".cmd-text pre")?.textContent).toBe("pnpm test")
  })

  it("say a failed command failed and keep the exit code and output in its tooltip", async () => {
    inLocale(
      <ToolBlock
        tool={tool(
          "Bash",
          { command: "pnpm lint" },
          {
            status: "failed",
            output: "\u001b[31merror\u001b[39m  no-constant-binary-expression",
            exitCode: 1,
          },
        )}
      />,
    )
    const status = screen.getByText("执行失败")
    expect(status.className).toContain("has-tip")
    await userEvent.hover(status)
    const tip = await screen.findByText(/退出码 1/)
    expect(tip.textContent).toBe("退出码 1\nerror  no-constant-binary-expression")
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy()
  })

  it("say when a finished command printed nothing", async () => {
    inLocale(<ToolBlock tool={tool("Bash", { command: "true" }, { output: "" })} />)
    await userEvent.click(screen.getByRole("button", { name: /终端/ }))
    expect(screen.getByText("没有输出。")).toBeTruthy()
  })

  it("group consecutive commands and count the failures", async () => {
    inLocale(
      <MessageList
        events={[
          e(1, "run.started", { text: "check" }),
          e(2, "tool.started", { id: "a", name: "Bash", input: { command: "pnpm lint" } }),
          e(3, "tool.completed", {
            id: "a",
            name: "Bash",
            output: "bad",
            isError: true,
            exitCode: 2,
          }),
          e(4, "tool.started", { id: "b", name: "Bash", input: { command: "pnpm test" } }),
          e(5, "tool.completed", { id: "b", name: "Bash", output: "ok", exitCode: 0 }),
          e(6, "message.completed", { role: "assistant", text: "done" }),
          e(7, "run.completed", {}),
        ]}
        onApproval={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole("button", { name: /已工作/ }))
    const group = screen.getByRole("button", { name: /终端.*2 个命令, 1 个失败/ })
    await userEvent.click(group)
    const children = group.parentElement!.querySelector(".tool-children")!
    expect(within(children as HTMLElement).getByText("pnpm lint")).toBeTruthy()
    expect(within(children as HTMLElement).getByText("执行失败")).toBeTruthy()
    expect(children.querySelector(".tool-row-icon")).toBeNull()
  })

  it("unwrap shell wrappers and strip terminal colours", () => {
    expect(commandText(JSON.stringify({ command: "bash -lc 'pnpm test --run'" }))).toBe(
      "pnpm test --run",
    )
    expect(commandText(JSON.stringify({ command: ["/bin/zsh", "-lc", "ls -la"] }))).toBe("ls -la")
    expect(commandText("git status")).toBe("git status")
    expect(plainOutput("\u001b[32m✓\u001b[0m ok\r\n")).toBe("✓ ok\n")
  })
})

describe("file rows", () => {
  it("show a read as the file name and its project-relative folder, opened from the name", async () => {
    const opened: string[] = []
    inLocale(<ToolBlock tool={tool("Read", { file_path: "/repo/src/index.ts" })} />, {
      root: "/repo",
      onOpenFile: (path) => opened.push(path),
    })
    const chip = screen.getByRole("button", { name: "index.ts" })
    expect(chip.getAttribute("title")).toBe("src/index.ts")
    expect(screen.getByText("src").className).toContain("file-parent")
    expect(screen.getByText("读取")).toBeTruthy()
    await userEvent.click(chip)
    expect(opened).toEqual(["/repo/src/index.ts"])
    expect(document.querySelector(".tool-row-head")?.getAttribute("aria-expanded")).toBeNull()
  })

  it("show an edit's line counts and open into an inline diff", async () => {
    const { container } = inLocale(
      <ToolBlock
        tool={tool("Edit", { file_path: "src/a.txt", old_string: "a", new_string: "b\nc" })}
      />,
    )
    expect(screen.getByLabelText("+2 -1").textContent).toBe("+2-1")
    await userEvent.click(screen.getByRole("button", { name: /编辑/ }))
    const lines = [...container.querySelectorAll(".idiff-line")].map(
      (line) =>
        `${line.className.replace("idiff-line ", "")}:${line.querySelector(".idiff-code")?.textContent}`,
    )
    expect(lines).toEqual(["is-remove:a", "is-add:b", "is-add:c"])
  })

  it("list each file of a multi-file patch", async () => {
    inLocale(
      <ToolBlock
        tool={tool("ApplyPatch", {
          changes: [
            { path: "a.ts", kind: { type: "add" }, diff: "+x\n+y" },
            { path: "b.ts", kind: { type: "update" }, diff: "-p\n+q" },
          ],
        })}
      />,
    )
    const head = screen.getByRole("button", { name: /编辑.*a\.ts.*b\.ts/ })
    await userEvent.click(head)
    expect(head.textContent).toContain("2 个文件")
    expect(screen.getAllByRole("button", { name: /写入|编辑/ })).toHaveLength(3)
  })
})

describe("search rows", () => {
  it("show what was searched and fetched on one line", () => {
    inLocale(
      <>
        <ToolBlock tool={tool("Grep", { pattern: "answer" }, { id: "g" })} />
        <ToolBlock tool={tool("WebFetch", { url: "https://pigcode.dev/docs" }, { id: "f" })} />
        <ToolBlock tool={tool("Glob", { pattern: "**/*.ts" }, { id: "l", status: "running" })} />
      </>,
    )
    expect(screen.getByText("answer").closest(".tool-row-head")?.textContent).toBe("搜索answer")
    expect(
      screen.getByText("https://pigcode.dev/docs").closest(".tool-row-head")?.textContent,
    ).toBe("网页抓取https://pigcode.dev/docs")
    expect(screen.getByText("正在搜索").className).toContain("tool-shimmer")
  })

  it("fold consecutive lookups into one explore row with counts by kind", async () => {
    inLocale(
      <MessageList
        events={[
          e(1, "run.started", { text: "look" }),
          e(2, "tool.started", { id: "r1", name: "Read", input: { file_path: "a.ts" } }),
          e(3, "tool.completed", { id: "r1", name: "Read", output: "a" }),
          e(4, "tool.started", { id: "r2", name: "Read", input: { file_path: "b.ts" } }),
          e(5, "tool.completed", { id: "r2", name: "Read", output: "b" }),
          e(6, "tool.started", { id: "g1", name: "Grep", input: { pattern: "x" } }),
          e(7, "tool.completed", { id: "g1", name: "Grep", output: "a.ts:1" }),
          e(8, "tool.started", { id: "w1", name: "WebFetch", input: { url: "https://x.dev" } }),
          e(9, "tool.completed", { id: "w1", name: "WebFetch", output: "page" }),
          e(10, "message.completed", { role: "assistant", text: "done" }),
          e(11, "run.completed", {}),
        ]}
        onApproval={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole("button", { name: /已工作/ }))
    const explore = screen.getByRole("button", { name: /查阅/ })
    expect(explore.textContent).toBe("查阅·2 文件, 1 搜索, 1 次网页抓取")
    await userEvent.click(explore)
    expect(screen.getByText("a.ts")).toBeTruthy()
    expect(screen.getByText("https://x.dev")).toBeTruthy()
  })
})
