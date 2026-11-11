/** 验证时间线的外围部件：用户气泡、思考、改动汇总与状态面板；会话导航见 turn-navigator.test.tsx。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileSummary } from "./file-summary"
import { ReasoningBlock } from "./reasoning"
import { StatusPanel } from "./status-panel"
import { resetToolOpen } from "./tool-open"
import { ConversationActionsContext, type ConversationActions } from "./tools"
import { buildTimeline } from "./turns"
import { UserBubble } from "./user-bubble"

afterEach(() => {
  cleanup()
  resetToolOpen()
  vi.restoreAllMocks()
})

function inLocale(node: ReactNode, actions: ConversationActions = {}) {
  return render(
    <LocaleProvider locale="zh-CN">
      <ConversationActionsContext.Provider value={actions}>
        {node}
      </ConversationActionsContext.Provider>
    </LocaleProvider>,
  )
}

function event(
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown,
  runId = "run_1",
): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: new Date(Date.UTC(2026, 9, 21, 8, 0, seq)).toISOString(),
  }
}

describe("UserBubble", () => {
  it("shows @-mentioned files as file names that open the file", async () => {
    const opened: string[] = []
    const { container } = inLocale(<UserBubble text="look at @src/index.ts, then mail a@b" />, {
      root: "/repo",
      onOpenFile: (path) => opened.push(path),
    })
    expect(container.querySelector(".msg-user")?.textContent).toBe(
      "look at index.ts, then mail a@b",
    )
    const mention = screen.getByRole("button", { name: "index.ts" })
    expect(mention.getAttribute("title")).toBe("src/index.ts")
    await userEvent.click(mention)
    expect(opened).toEqual(["src/index.ts"])
  })

  it("folds long messages behind an expand button", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400)
    const { container } = inLocale(<UserBubble text={"line\n".repeat(30)} />)
    const body = container.querySelector<HTMLElement>(".msg-user-body")!
    expect(body.style.maxHeight).toBe("120px")
    expect(container.querySelector(".msg-user")?.hasAttribute("data-clamped")).toBe(true)
    await userEvent.click(screen.getByRole("button", { name: "展开" }))
    expect(body.style.maxHeight).toBe("400px")
    expect(screen.getByRole("button", { name: "收起" }).getAttribute("aria-expanded")).toBe("true")
  })
})

describe("ReasoningBlock", () => {
  it("says how long the thought took and opens into the plain text", async () => {
    const { container } = inLocale(
      <ReasoningBlock id="r1" text={"First idea.\nSecond idea."} durationMs={4200} />,
    )
    const head = screen.getByRole("button", { name: /思考/ })
    expect(head.textContent).toBe("思考·持续了 5 秒")
    expect(head.getAttribute("aria-expanded")).toBe("false")
    await userEvent.click(head)
    expect(container.querySelector(".reasoning-body")?.textContent).toBe(
      "First idea.\nSecond idea.",
    )
    cleanup()
    inLocale(<ReasoningBlock id="r2" text="Hmm." durationMs={null} />)
    expect(screen.getByRole("button", { name: /思考/ }).textContent).toBe("思考·持续了几秒")
  })
})

describe("FileSummary", () => {
  it("lists the changed files with review and open actions", async () => {
    const reviewed: Array<string | undefined> = []
    const opened: string[] = []
    inLocale(
      <FileSummary
        id="turn-1"
        files={[
          { path: "/repo/src/index.ts", operation: "edit", added: 3, removed: 1, lines: [] },
          { path: "/repo/README.md", operation: "write", added: 10, removed: 0, lines: [] },
        ]}
      />,
      {
        root: "/repo",
        onViewDiff: (path) => reviewed.push(path),
        onOpenFile: (path) => opened.push(path),
      },
    )
    const head = screen.getByRole("button", { name: "展开已更改文件" })
    expect(head.textContent).toBe("2 个文件已更改+13 -1")
    await userEvent.click(head)
    expect(screen.getByRole("button", { name: "收起已更改文件" })).toBeTruthy()
    expect(screen.getByText("src").className).toBe("file-summary-path")
    await userEvent.click(screen.getAllByRole("button", { name: "审查" })[0]!)
    expect(reviewed).toEqual(["/repo/src/index.ts"])
    await userEvent.click(screen.getByRole("button", { name: "在文件面板中打开 README.md" }))
    expect(opened).toEqual(["/repo/README.md"])
  })
})

describe("StatusPanel", () => {
  const todos = [
    { content: "Read the code", status: "completed" },
    { content: "Fix the bug", status: "in_progress" },
    { content: "Run the tests", status: "pending" },
  ]

  it("shows the current todo in a capsule and the full list when expanded", async () => {
    const timeline = buildTimeline([
      event(1, "run.started", { text: "fix" }),
      event(2, "tool.started", { id: "t1", name: "TodoWrite", input: { todos } }),
      event(3, "tool.started", { id: "b1", name: "Bash", input: { command: "pnpm dev" } }),
    ])
    inLocale(<StatusPanel timeline={timeline} />)
    const capsule = screen.getByRole("button", { name: "展开状态" })
    expect(capsule.textContent).toBe("Fix the bug")
    await userEvent.click(capsule)
    const panel = screen.getByRole("complementary", { name: "状态" })
    expect(panel.textContent).toContain("进程1/3")
    expect(panel.querySelector("[data-status='completed']")?.textContent).toBe("Read the code")
    expect(panel.textContent).toContain("运行中的后台任务1")
    expect(panel.textContent).toContain("pnpm dev")
    await userEvent.click(screen.getByRole("button", { name: "收起为胶囊" }))
    expect(screen.getByRole("button", { name: "展开状态" })).toBeTruthy()
  })

  it("stays out of the way when there is nothing to report", () => {
    const { container } = inLocale(
      <StatusPanel timeline={buildTimeline([event(1, "run.started", { text: "hi" })])} />,
    )
    expect(container.querySelector(".status-panel")).toBeNull()
  })
})

describe("thread references in the user bubble", () => {
  it("draws a referenced thread as a chip that opens it, and still shows file mentions", async () => {
    const onOpenThread = vi.fn()
    inLocale(
      <UserBubble
        text="看 @重构解析器 和 @src/parser.ts 再对照 @修登录"
        references={[
          { threadId: "t1", title: "重构解析器" },
          { threadId: "t2", title: "修登录" },
        ]}
      />,
      { onOpenThread },
    )
    const chips = screen.getAllByRole("button", { name: /重构解析器|修登录/ })
    expect(chips.map((chip) => chip.textContent)).toEqual(["重构解析器", "修登录"])
    expect(document.querySelector(".mention-file:not(.mention-thread)")?.textContent).toBe(
      "parser.ts",
    )
    await userEvent.click(chips[1]!)
    expect(onOpenThread).toHaveBeenCalledWith("t2")
  })

  it("leaves @text alone when the message did not record it as a reference", () => {
    inLocale(<UserBubble text="ping @重构解析器 please" />)
    expect(document.querySelector(".mention-thread")).toBeNull()
    expect(document.body.textContent).toContain("ping @重构解析器 please")
  })
})
