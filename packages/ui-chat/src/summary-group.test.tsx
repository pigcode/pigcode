/** 验证纯修改摘要组收起态的文件 chip 按容器可用宽度动态排布与缩放响应（pigcode/monorepo#131）。 */
// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MessageList } from "./message-list"
import { resetToolOpen } from "./tool-open"
import { WithToolRenderers } from "./tools/tool-renderers.fixtures"

function makeRect(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 24,
    width,
    height: 24,
    toJSON: () => ({}),
  } as DOMRect
}

function event(seq: number, type: ThreadEvent["type"], payload: unknown = {}): ThreadEvent {
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

function editEvents(paths: readonly string[]): ThreadEvent[] {
  const list: ThreadEvent[] = [event(1, "run.started", { text: "edit files" })]
  let seq = 2
  for (const [index, path] of paths.entries()) {
    const id = `e${index + 1}`
    list.push(
      event(seq++, "tool.started", {
        id,
        name: "Edit",
        input: { file_path: path, old_string: "a", new_string: "b" },
      }),
      event(seq++, "tool.completed", { id, name: "Edit", output: "ok" }),
    )
  }
  list.push(event(seq, "run.completed", {}))
  return list
}

function renderEdits(paths: readonly string[]) {
  return render(
    <LocaleProvider locale="zh-CN">
      <WithToolRenderers>
        <MessageList events={editEvents(paths)} root="/repo" onApproval={() => {}} />
      </WithToolRenderers>
    </LocaleProvider>,
  )
}

interface MockResizeController {
  trigger: () => void
  disconnectCount: () => number
}

function stubResizeObserver(): MockResizeController {
  const callbacks = new Set<ResizeObserverCallback>()
  let disconnects = 0
  class MockResizeObserver {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      callbacks.add(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {
      disconnects += 1
      callbacks.delete(this.callback)
    }
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver)
  return {
    trigger: () => {
      for (const callback of [...callbacks]) {
        callback([], {} as ResizeObserver)
      }
    },
    disconnectCount: () => disconnects,
  }
}

function mockLayoutWidths(widths: {
  groupWidth: () => number
  filesLeft?: number
  labelWidth?: number
  chipWidth?: number
  moreWidth?: number
}) {
  const { filesLeft = 24, labelWidth = 90, chipWidth = 80, moreWidth = 28 } = widths
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("summary-group")) return makeRect(0, widths.groupWidth())
    if (this.classList.contains("summary-group-files")) return makeRect(filesLeft, 200)
    if (this.classList.contains("summary-group-label")) return makeRect(0, labelWidth)
    if (this.classList.contains("file-chip")) return makeRect(0, chipWidth)
    if (this.classList.contains("summary-group-more")) return makeRect(0, moreWidth)
    return makeRect(0, 0)
  })
}

afterEach(() => {
  cleanup()
  resetToolOpen()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SummaryGroup dynamic changed-file chips", () => {
  it("shows more than 3 file chips in a wide container and hides +N when all fit", () => {
    stubResizeObserver()
    mockLayoutWidths({ groupWidth: () => 700 })
    const { container } = renderEdits([
      "/repo/a.ts",
      "/repo/b.ts",
      "/repo/c.ts",
      "/repo/d.ts",
      "/repo/e.ts",
    ])
    // 可用宽度 700 - 24 - 24 = 652；90 + 5 * (8 + 80) = 530 <= 652，全部 5 枚都能显示
    const chips = [...container.querySelectorAll(".summary-group-head .file-chip")]
    expect(chips.map((el) => el.textContent)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])
    expect(container.querySelector(".summary-group-more")).toBeNull()
  })

  it("shows as many chips as fit (including >3) followed by +N when not all fit", () => {
    stubResizeObserver()
    // 6 个文件，可用宽度 540 - 24 - 24 = 492：
    // 4 枚 + +2 需要 90 + 4 * 88 + 8 + 28 = 478 <= 492；5 枚 + +1 需要 566 > 492
    mockLayoutWidths({ groupWidth: () => 540 })
    const { container } = renderEdits([
      "/repo/a.ts",
      "/repo/b.ts",
      "/repo/c.ts",
      "/repo/d.ts",
      "/repo/e.ts",
      "/repo/f.ts",
    ])
    const chips = [...container.querySelectorAll(".summary-group-head .file-chip")]
    expect(chips.map((el) => el.textContent)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"])
    expect(container.querySelector(".summary-group-more")?.textContent).toBe("+2")
    // 测量容器不会残留在 DOM 中，隐藏的文件也不会被 queryByText 误检到
    expect(screen.queryByText("e.ts")).toBeNull()
    expect(screen.queryByText("f.ts")).toBeNull()
  })

  it("recalculates shown file chips when the container resizes narrower and wider", () => {
    const ro = stubResizeObserver()
    let currentWidth = 700
    mockLayoutWidths({ groupWidth: () => currentWidth })

    const { container, unmount } = renderEdits([
      "/repo/a.ts",
      "/repo/b.ts",
      "/repo/c.ts",
      "/repo/d.ts",
      "/repo/e.ts",
    ])
    expect(container.querySelectorAll(".summary-group-head .file-chip")).toHaveLength(5)
    expect(container.querySelector(".summary-group-more")).toBeNull()

    // 缩窄到 280（可用 232）：label 90 + 1 枚 88 + +4(36) = 214 <= 232，2 枚 302 > 232
    currentWidth = 280
    act(() => ro.trigger())
    expect(
      [...container.querySelectorAll(".summary-group-head .file-chip")].map((el) => el.textContent),
    ).toEqual(["a.ts"])
    expect(container.querySelector(".summary-group-more")?.textContent).toBe("+4")
    expect(screen.queryByText("b.ts")).toBeNull()

    // 进一步缩窄到 160（可用 112）：连 1 枚 chip + +4 都放不下，退回仅显示统计文案，无冗余 +5
    currentWidth = 160
    act(() => ro.trigger())
    expect(container.querySelectorAll(".summary-group-head .file-chip")).toHaveLength(0)
    expect(container.querySelector(".summary-group-more")).toBeNull()
    expect(container.querySelector(".summary-group-label")?.textContent).toBe("已修改 5 文件")

    // 重新拉宽到 700，恢复全部 5 枚
    currentWidth = 700
    act(() => ro.trigger())
    expect(container.querySelectorAll(".summary-group-head .file-chip")).toHaveLength(5)
    expect(container.querySelector(".summary-group-more")).toBeNull()

    unmount()
    expect(ro.disconnectCount()).toBeGreaterThan(0)
  })

  it("supports offsetWidth measurement fallback when getBoundingClientRect returns 0", () => {
    stubResizeObserver()
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains("summary-group")) return 350
        if (this.classList.contains("summary-group-label")) return 90
        if (this.classList.contains("file-chip")) return 80
        if (this.classList.contains("summary-group-more")) return 28
        return 0
      },
    })
    try {
      const { container } = renderEdits([
        "/repo/a.ts",
        "/repo/b.ts",
        "/repo/c.ts",
        "/repo/d.ts",
        "/repo/e.ts",
      ])
      // 可用 350 - 24 = 326：label 90 + 2 枚 (176) + +3 (36) = 302 <= 326；3 枚 = 390 > 326
      expect(
        [...container.querySelectorAll(".summary-group-head .file-chip")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["a.ts", "b.ts"])
      expect(container.querySelector(".summary-group-more")?.textContent).toBe("+3")
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth")
    }
  })

  it("keeps single-file wording intact, degrades safely without ResizeObserver, and shows only statistics when expanded", async () => {
    vi.stubGlobal("ResizeObserver", undefined)
    // 单文件（对同一文件两次编辑去重为 1 个文件）继续显示「已修改 + 文件 chip」
    const single = renderEdits(["/repo/src/index.ts", "/repo/src/./index.ts"])
    expect(single.container.querySelector(".summary-group-label")?.textContent).toBe("已修改")
    expect(
      [...single.container.querySelectorAll(".summary-group-head .file-chip")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["index.ts"])
    expect(single.container.querySelector(".summary-group-more")).toBeNull()
    single.unmount()

    // jsdom 无 ResizeObserver 且宽度为 0 时安全降级，不报错且可展开切回统计文案
    const multi = renderEdits(["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/d.ts"])
    const head = screen.getByRole("button", { name: "已修改 4 文件" })
    expect(
      multi.container.querySelectorAll(".summary-group-head .file-chip").length,
    ).toBeGreaterThan(0)

    await userEvent.click(head)
    expect(head.getAttribute("aria-expanded")).toBe("true")
    expect(head.textContent).toBe("已修改 4 文件")
    expect(multi.container.querySelectorAll(".summary-group-head .file-chip")).toHaveLength(0)
    expect(multi.container.querySelectorAll(".summary-group-list .file-chip")).toHaveLength(4)
  })
})

describe("SummaryGroup runtime boundaries", () => {
  function renderTimeline(events: ThreadEvent[]) {
    return render(
      <LocaleProvider locale="zh-CN">
        <WithToolRenderers>
          <MessageList events={events} root="/repo" onApproval={() => {}} />
        </WithToolRenderers>
      </LocaleProvider>,
    )
  }

  it("hides an empty streaming shell until its command arrives or the tool finishes", () => {
    const base = [
      event(1, "run.started", { text: "run command" }),
      event(2, "tool.started", { id: "b1", name: "Bash", input: {} }),
    ]
    const { container, rerender } = renderTimeline(base)
    expect(container.querySelector(".cmd-row")).toBeNull()
    expect(container.querySelector(".turn-work")).toBeNull()

    // 收到命令文本后正常渲染
    const withCommand = [
      ...base,
      event(3, "tool.started", { id: "b1", name: "Bash", input: { command: "pnpm test" } }),
    ]
    rerender(
      <LocaleProvider locale="zh-CN">
        <WithToolRenderers>
          <MessageList events={withCommand} root="/repo" onApproval={() => {}} />
        </WithToolRenderers>
      </LocaleProvider>,
    )
    expect(screen.getByRole("button", { name: /正在执行/ }).textContent).toContain("pnpm test")

    // 与查阅相邻且工具完成后（即便命令本身为空）正常参与摘要分组
    const finishedEmpty = [
      event(1, "run.started", { text: "run command" }),
      event(2, "tool.started", { id: "r1", name: "Read", input: { file_path: "a.ts" } }),
      event(3, "tool.completed", { id: "r1", name: "Read", output: "ok" }),
      event(4, "tool.started", { id: "b2", name: "Bash", input: {} }),
      event(5, "tool.completed", { id: "b2", name: "Bash", output: "" }),
      event(6, "run.completed", {}),
    ]
    rerender(
      <LocaleProvider locale="zh-CN">
        <WithToolRenderers>
          <MessageList events={finishedEmpty} root="/repo" onApproval={() => {}} />
        </WithToolRenderers>
      </LocaleProvider>,
    )
    expect(screen.getByRole("button", { name: "已查阅 1 项，已执行 1 命令" })).toBeTruthy()
  })

  it("keeps a pending-approval tool outside the summary group and merges it back once resolved", () => {
    const waitingEvents = [
      event(1, "run.started", { text: "deploy" }),
      event(2, "tool.started", { id: "r1", name: "Read", input: { file_path: "a.ts" } }),
      event(3, "tool.completed", { id: "r1", name: "Read", output: "a" }),
      event(4, "tool.started", { id: "g1", name: "Grep", input: { pattern: "deploy" } }),
      event(5, "tool.completed", { id: "g1", name: "Grep", output: "a.ts:1" }),
      event(6, "tool.started", { id: "b1", name: "Bash", input: { command: "./deploy.sh" } }),
      event(7, "approval.requested", {
        id: "req_1",
        toolCallId: "b1",
        toolName: "Bash",
        title: "Run deploy",
        command: "./deploy.sh",
      }),
    ]
    const { container, rerender } = renderTimeline(waitingEvents)
    // 前面的 Read + Grep 合成摘要组，待审批的 Bash 保持独立可见（不进组）。
    expect(screen.getByRole("button", { name: "已查阅 2 项" })).toBeTruthy()
    const standaloneBash = container.querySelector(".turn-work > .cmd-row")
    expect(standaloneBash).not.toBeNull()
    expect(standaloneBash?.textContent).toContain("./deploy.sh")
    expect(screen.getByRole("group", { name: "要你确认" })).toBeTruthy()

    // 审批通过并完成后，三项恢复归入同一摘要组。
    const resolvedEvents = [
      ...waitingEvents,
      event(8, "approval.resolved", { id: "req_1", decision: "allow-once" }),
      event(9, "tool.completed", { id: "b1", name: "Bash", output: "ok" }),
      event(10, "run.completed", {}),
    ]
    rerender(
      <LocaleProvider locale="zh-CN">
        <WithToolRenderers>
          <MessageList events={resolvedEvents} root="/repo" onApproval={() => {}} />
        </WithToolRenderers>
      </LocaleProvider>,
    )
    expect(container.querySelector(".turn-work > .cmd-row")).toBeNull()
    expect(screen.getByRole("button", { name: "已查阅 2 项，已执行 1 命令" })).toBeTruthy()
  })
})
