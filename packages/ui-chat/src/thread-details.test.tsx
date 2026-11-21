/**
 * 验证会话详情：线程头的开关、窄的会话区里从按钮弹出的卡片、宽的会话区里钉在右上角的卡片（默认打开，
 * 关掉后记住），以及卡片里的待办和后台任务。
 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { resetComposerMemory } from "@pigcode/ui-composer"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatView } from "./chat-view"

const thread = {
  id: "t1",
  projectId: "p1",
  title: "Fix the bug",
  defaultAgentId: "fake",
  defaultInstanceId: null,
  lastAgentId: null,
  lastInstanceId: null,
  lastModelId: null,
  permissionMode: "full-access" as const,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  archivedAt: null,
  lastRunId: null,
}

function event(seq: number, type: ThreadEvent["type"], payload: unknown): ThreadEvent {
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

const todos = [
  { content: "Read the code", status: "completed" },
  { content: "Fix the bug", status: "in_progress" },
  { content: "Run the tests", status: "pending" },
]

/** 正在跑的一轮：列了待办，还有一条没结束的命令。 */
const working = [
  event(1, "run.started", { text: "fix" }),
  event(2, "tool.started", { id: "todo", name: "TodoWrite", input: { todos } }),
  event(3, "tool.started", { id: "dev", name: "Bash", input: { command: "pnpm dev" } }),
]

const workspace = (
  <section className="details-section">
    <button type="button">用 Cursor 打开</button>
  </section>
)

/** 让会话区量出来有这么宽；jsdom 不排版，量到的都是 0。 */
function conversationWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, this.classList.contains("chat-view") ? width : 0, 0)
  })
}

function renderChat(events: ThreadEvent[], details: ReactNode = workspace) {
  return render(
    <LocaleProvider locale="zh-CN">
      <ChatView thread={thread} events={events} details={details} />
    </LocaleProvider>,
  )
}

beforeEach(() => window.localStorage.clear())

afterEach(() => {
  cleanup()
  resetComposerMemory()
  vi.restoreAllMocks()
})

describe("thread details in a narrow conversation", () => {
  it("shows to-do progress on the header button and the full card when opened", async () => {
    renderChat(working)
    const toggle = screen.getByRole("button", { name: "会话详情（待办 1/3）" })
    expect(toggle.textContent).toBe("1/3")
    expect(screen.queryByRole("complementary", { name: "会话详情" })).toBeNull()

    await userEvent.click(toggle)
    const card = await screen.findByRole("dialog", { name: "会话详情" })
    expect(within(card).getByRole("button", { name: "用 Cursor 打开" })).toBeTruthy()
    const todoSection = within(card).getByRole("region", { name: "待办" })
    expect(todoSection.textContent).toContain("1/3")
    expect(todoSection.querySelector("[data-status='completed']")?.textContent).toBe(
      "Read the code",
    )
    expect(todoSection.querySelector("[data-status='in-progress']")?.textContent).toBe(
      "Fix the bug",
    )
    const running = within(card).getByRole("region", { name: "后台任务" })
    expect(running.textContent).toContain("pnpm dev")
    // 卡片开着就不在按钮上重复进度。
    expect(screen.getByRole("button", { name: "会话详情" }).textContent).toBe("")

    await userEvent.click(within(todoSection).getByRole("button", { name: "待办" }))
    expect(todoSection.querySelector(".details-todos")).toBeNull()
  })

  it("has no header button when there is nothing to show", () => {
    renderChat([event(1, "run.started", { text: "hi" })], null)
    expect(screen.queryByRole("button", { name: /会话详情/ })).toBeNull()
  })
})

describe("thread details in a wide conversation", () => {
  it("pins the card open, makes room for it and remembers when it is closed", async () => {
    conversationWidth(1200)
    const { container, unmount } = renderChat(working)
    const card = screen.getByRole("complementary", { name: "会话详情" })
    expect(within(card).getByRole("region", { name: "待办" })).toBeTruthy()
    expect(container.querySelector(".chat-view")?.getAttribute("data-details")).toBe("pinned")
    const toggle = screen.getByRole("button", { name: "会话详情" })
    expect(toggle.getAttribute("aria-pressed")).toBe("true")

    await userEvent.click(toggle)
    expect(screen.queryByRole("complementary", { name: "会话详情" })).toBeNull()
    expect(container.querySelector(".chat-view")?.hasAttribute("data-details")).toBe(false)
    expect(window.localStorage.getItem("pigcode.threadDetails")).toBe("hidden")
    expect(screen.getByRole("button", { name: "会话详情（待办 1/3）" })).toBeTruthy()

    unmount()
    renderChat(working)
    expect(screen.queryByRole("complementary", { name: "会话详情" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "会话详情（待办 1/3）" }))
    expect(screen.getByRole("complementary", { name: "会话详情" })).toBeTruthy()
    expect(window.localStorage.getItem("pigcode.threadDetails")).toBeNull()
  })

  it("keeps the greeting centered before the first message and leaves the card to the button", () => {
    conversationWidth(1200)
    const { container } = renderChat([])
    expect(screen.queryByRole("complementary", { name: "会话详情" })).toBeNull()
    expect(container.querySelector(".chat-view")?.hasAttribute("data-details")).toBe(false)
    // 这时是浮层的触发按钮，不是钉住的切换按钮。
    const toggle = screen.getByRole("button", { name: "会话详情" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.hasAttribute("aria-pressed")).toBe(false)
  })
})
