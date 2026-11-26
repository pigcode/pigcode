/** 验证底部终端抽屉高度在窗口缩放时让出聊天空间，并在恢复高度后回到用户设定值。 */
// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Connection } from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { TerminalDrawer, clampDrawerHeight } from "./terminal-drawer"

vi.mock("./terminal-surface", () => ({
  TerminalSurface: () => <div data-testid="mock-terminal-surface" />,
}))

const connection = {
  call: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
} as unknown as Connection

afterEach(() => {
  cleanup()
})

describe("clampDrawerHeight", () => {
  it("caps drawer height to preserve chat space while keeping minimum usable height", () => {
    expect(clampDrawerHeight(450, 800)).toBe(450)
    expect(clampDrawerHeight(600, 800)).toBe(560)
    expect(clampDrawerHeight(450, 480)).toBe(280)
    expect(clampDrawerHeight(260, 320)).toBe(140)
  })
})

describe("TerminalDrawer responsive height", () => {
  it("clamps drawer height when the panel shrinks and restores the dragged height when it widens back", () => {
    let panelHeight = 800
    const { container } = render(
      <LocaleProvider locale="zh-CN">
        <main className="panel">
          <TerminalDrawer
            connection={connection}
            owner={{ threadId: "t1" }}
            open
            onClose={() => {}}
          />
        </main>
      </LocaleProvider>,
    )
    const panel = container.querySelector(".panel") as HTMLElement
    Object.defineProperty(panel, "clientHeight", {
      configurable: true,
      get: () => panelHeight,
    })
    const drawer = container.querySelector(".terminal-drawer") as HTMLElement
    const resizer = container.querySelector(".terminal-drawer-resizer") as HTMLElement

    // 拖高抽屉到 460px（起始默认 260px，往上拖 200px）。
    act(() => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 500 }))
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 300 }))
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: 300 }))
    })
    expect(drawer.style.height).toBe("460px")

    // 窗口变矮到 480px：自动夹紧到 280px，上方留出 200px 聊天空间。
    panelHeight = 480
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(drawer.style.height).toBe("280px")

    // 窗口拉回 800px：无损恢复到用户拖好的 460px。
    panelHeight = 800
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(drawer.style.height).toBe("460px")
  })
})
