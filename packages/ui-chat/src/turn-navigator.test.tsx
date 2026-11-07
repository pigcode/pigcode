/** 验证会话导航：每条用户消息一条短横线，悬停预览、点击与方向键跳转，以及当前那一条。 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ThreadEvent } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TurnNavigator, plainPreview } from "./turn-navigator"
import { buildTimeline } from "./turns"

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function event(
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown,
  runId: string,
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

/** 一轮问答；answer 为 null 时这一轮还在跑。 */
function turn(seq: number, runId: string, text: string, answer: string | null): ThreadEvent[] {
  const started = event(seq, "run.started", { text }, runId)
  if (answer === null) return [started]
  return [
    started,
    event(seq + 1, "message.completed", { role: "assistant", text: answer }, runId),
    event(seq + 2, "run.completed", {}, runId),
  ]
}

const THREE_TURNS = [
  ...turn(1, "run_1", "first question", "**First** answer"),
  ...turn(4, "run_2", "second question\nwith a second line", "## Second\n\nanswer body"),
  ...turn(7, "run_3", "third question", null),
]

/**
 * 一个会话滚动容器：2000px 高的内容放在 500px 高的视口里，第 n 轮的顶部在内容的 n*600px 处，
 * 视口顶部在屏幕 100px 处。
 */
function conversation(keys: readonly string[], scrollTop = 0) {
  const scroller = document.createElement("div")
  Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true })
  Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true })
  scroller.scrollTop = scrollTop
  scroller.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 800, height: 500 })
  scroller.scrollTo = vi.fn()
  keys.forEach((key, index) => {
    const section = document.createElement("section")
    section.className = "turn"
    section.dataset.turn = key
    section.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 100 + index * 600 - scroller.scrollTop, width: 800, height: 400 })
    scroller.append(section)
  })
  document.body.append(scroller)
  return scroller
}

function renderNavigator(events: ThreadEvent[], scroller: HTMLElement) {
  return render(
    <LocaleProvider locale="zh-CN">
      <TurnNavigator timeline={buildTimeline(events)} scroller={{ current: scroller }} />
    </LocaleProvider>,
  )
}

const item = (index: number) => screen.getByRole("button", { name: `跳到第 ${index} 条消息` })

describe("TurnNavigator", () => {
  it("shows one tick per user message, and nothing until there are two", () => {
    const scroller = conversation(["run_1", "run_2", "run_3"])
    const { rerender } = renderNavigator(turn(1, "run_1", "only question", "answer"), scroller)
    expect(screen.queryByRole("navigation", { name: "会话导航" })).toBeNull()

    rerender(
      <LocaleProvider locale="zh-CN">
        <TurnNavigator timeline={buildTimeline(THREE_TURNS)} scroller={{ current: scroller }} />
      </LocaleProvider>,
    )
    const nav = screen.getByRole("navigation", { name: "会话导航" })
    expect(nav.querySelectorAll(".turn-nav-bar")).toHaveLength(3)
  })

  it("marks the message being read as current, and the last one at the bottom", async () => {
    const scroller = conversation(["run_1", "run_2", "run_3"], 700)
    renderNavigator(THREE_TURNS, scroller)
    // 第二轮的顶部（屏幕 100 + 600 - 700 = 0）已经越过视口上方三分之一处，第三轮还没有。
    await waitFor(() => expect(item(2).getAttribute("aria-current")).toBe("location"))
    expect(item(2).tabIndex).toBe(0)
    expect(item(1).tabIndex).toBe(-1)

    scroller.scrollTop = 1500
    scroller.dispatchEvent(new Event("scroll"))
    await waitFor(() => expect(item(3).getAttribute("aria-current")).toBe("location"))
  })

  it("jumps to a message on click and keeps it current while the conversation scrolls there", async () => {
    const scroller = conversation(["run_1", "run_2", "run_3"])
    renderNavigator(THREE_TURNS, scroller)
    await userEvent.click(item(2))
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" })
    expect(item(2).getAttribute("aria-current")).toBe("location")
    // 指针还停在这条上，预览不因为点击收起。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByText("second question with a second line")).toBeTruthy()

    // 平滑滚动途中仍是第二条；到了以后用户再往下滚，按位置重新算。
    scroller.scrollTop = 300
    scroller.dispatchEvent(new Event("scroll"))
    scroller.scrollTop = 600
    scroller.dispatchEvent(new Event("scroll"))
    await waitFor(() => expect(item(2).getAttribute("aria-current")).toBe("location"))
    scroller.scrollTop = 1500
    scroller.dispatchEvent(new Event("scroll"))
    await waitFor(() => expect(item(3).getAttribute("aria-current")).toBe("location"))
  })

  it("previews the hovered message with the start of its answer, and Escape closes it", async () => {
    const scroller = conversation(["run_1", "run_2", "run_3"])
    renderNavigator(THREE_TURNS, scroller)
    await userEvent.hover(item(2))
    const card = await screen.findByText("second question with a second line")
    expect(card.closest(".turn-nav-card")?.textContent).toBe(
      "second question with a second lineSecond answer body",
    )

    await userEvent.hover(item(3))
    expect(await screen.findByText("third question")).toBeTruthy()
    expect(screen.getByText("助手仍在工作")).toBeTruthy()
    expect(screen.queryByText("second question with a second line")).toBeNull()

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("third question")).toBeNull())
  })

  it("moves between messages with the arrow keys and jumps to each", async () => {
    const scroller = conversation(["run_1", "run_2", "run_3"], 1500)
    renderNavigator(THREE_TURNS, scroller)
    await waitFor(() => expect(item(3).tabIndex).toBe(0))
    item(3).focus()
    await userEvent.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(item(2))
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: "smooth" })
    await userEvent.keyboard("{Home}")
    expect(document.activeElement).toBe(item(1))
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" })
  })

  it("previews answers without Markdown syntax", () => {
    expect(
      plainPreview(
        "## 改动\n\n| 文件 | 改动 |\n| --- | :---: |\n| `src/a.ts` | **新建** |\n\n```ts\nconst a = 1\n```\n- 跑过 [测试](https://x.dev)",
      ),
    ).toBe("改动 文件 改动 src/a.ts 新建 跑过 测试")
  })
})
