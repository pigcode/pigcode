/**
 * 验证侧栏的分隔条：方向键与 Home/End、双击复位、拖动跟手、拖动中 Esc 取消、范围与记住宽度；
 * 拖动时窗口上的透明遮罩只在拖动中存在；设置侧栏用同一个宽度；侧栏收起或在窄窗口里变成抽屉时没有分隔条。
 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Shell } from "./shell"

const KEY = "pigcode.sidebarWidth"

beforeEach(() => window.localStorage.removeItem(KEY))
afterEach(() => {
  cleanup()
  window.localStorage.removeItem(KEY)
})

function renderShell(props: Partial<ComponentProps<typeof Shell>> = {}) {
  return render(
    <LocaleProvider locale="zh-CN">
      <Shell
        view="chat"
        projects={[]}
        threads={[]}
        activeThreadId={null}
        onView={() => {}}
        onAddProject={() => {}}
        onNewThread={() => {}}
        onOpenThread={() => {}}
        {...props}
      />
    </LocaleProvider>,
  )
}

const separator = () => screen.getByRole("separator", { name: "调整侧栏宽度" })
const sidebarWidth = (container: HTMLElement) =>
  (container.querySelector(".app") as HTMLElement).style.getPropertyValue("--sidebar-w")

/** jsdom 没有 PointerEvent；React 只看事件名，用同名的 MouseEvent 代替。 */
function pointer(target: EventTarget, type: string, clientX: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }))
  })
}

describe("sidebar resizer", () => {
  it("steps with the arrow keys, jumps to the ends with Home and End, resets on double-click", () => {
    const { container } = renderShell()
    const handle = separator()
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
    expect(handle.getAttribute("aria-valuemin")).toBe("210")
    expect(handle.getAttribute("aria-valuemax")).toBe("400")
    expect(handle.getAttribute("aria-valuenow")).toBe("260")
    expect(sidebarWidth(container)).toBe("260px")

    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(sidebarWidth(container)).toBe("284px")
    expect(handle.getAttribute("aria-valuenow")).toBe("284")
    expect(window.localStorage.getItem(KEY)).toBe("284")
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(sidebarWidth(container)).toBe("236px")
    fireEvent.keyDown(handle, { key: "End" })
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(sidebarWidth(container)).toBe("400px")
    fireEvent.keyDown(handle, { key: "Home" })
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(sidebarWidth(container)).toBe("210px")
    fireEvent.doubleClick(handle)
    expect(sidebarWidth(container)).toBe("260px")
    expect(window.localStorage.getItem(KEY)).toBe("260")
  })

  it("follows the pointer within its range and puts the width back on Esc", () => {
    const { container } = renderShell()
    const handle = separator()

    pointer(handle, "pointerdown", 260)
    expect(handle.hasAttribute("data-resizing")).toBe(false)
    pointer(window, "pointermove", 330)
    expect(document.body.classList.contains("is-resizing")).toBe(true)
    expect(handle.hasAttribute("data-resizing")).toBe(true)
    expect(sidebarWidth(container)).toBe("330px")
    pointer(window, "pointermove", 100)
    expect(sidebarWidth(container)).toBe("210px")
    pointer(window, "pointermove", 900)
    expect(sidebarWidth(container)).toBe("400px")
    pointer(window, "pointerup", 900)
    expect(document.body.classList.contains("is-resizing")).toBe(false)
    expect(handle.hasAttribute("data-resizing")).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBe("400")

    pointer(handle, "pointerdown", 400)
    pointer(window, "pointermove", 300)
    expect(sidebarWidth(container)).toBe("300px")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(sidebarWidth(container)).toBe("400px")
    expect(document.body.classList.contains("is-resizing")).toBe(false)
    pointer(window, "pointermove", 250)
    expect(sidebarWidth(container)).toBe("400px")
  })

  it("covers the window once the pointer moves, and drops the cover on pointerup, Esc and unmount", () => {
    const { container, unmount } = renderShell()
    const overlay = () => document.querySelector(".resize-overlay")
    const drag = (from: number, to: number) => {
      pointer(separator(), "pointerdown", from)
      pointer(window, "pointermove", to)
    }

    // 只是按下又松开（单击、双击）：不盖遮罩，双击复位落得到分隔条上；webview 从按下起就不接指针。
    pointer(separator(), "pointerdown", 260)
    pointer(window, "pointermove", 260)
    expect(overlay()).toBeNull()
    expect(document.body.classList.contains("is-resizing")).toBe(true)
    pointer(window, "pointerup", 260)
    expect(overlay()).toBeNull()
    expect(document.body.classList.contains("is-resizing")).toBe(false)

    drag(260, 280)
    expect(overlay()?.parentElement).toBe(document.body)
    expect(overlay()?.getAttribute("aria-hidden")).toBe("true")
    pointer(window, "pointerup", 280)
    expect(overlay()).toBeNull()

    drag(280, 300)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(overlay()).toBeNull()
    expect(sidebarWidth(container)).toBe("280px")

    // 拖着时按 ⌘B 收起侧栏：分隔条卸载，遮罩、body 上的状态和监听一起收掉，之后的移动不再改宽度。
    drag(280, 300)
    fireEvent.keyDown(window, { key: "b", ctrlKey: true })
    expect(screen.queryByRole("separator", { name: "调整侧栏宽度" })).toBeNull()
    expect(overlay()).toBeNull()
    expect(document.body.classList.contains("is-resizing")).toBe(false)
    pointer(window, "pointermove", 360)
    expect(sidebarWidth(container)).toBe("300px")

    fireEvent.keyDown(window, { key: "b", ctrlKey: true })
    drag(300, 320)
    expect(overlay()).not.toBeNull()
    unmount()
    expect(overlay()).toBeNull()
    expect(document.body.classList.contains("is-resizing")).toBe(false)
  })

  it("starts from the saved width, kept within range, and the settings sidebar uses it too", () => {
    window.localStorage.setItem(KEY, "333")
    const settings = renderShell({ view: "settings" })
    expect(screen.getByRole("button", { name: "返回应用" })).toBeTruthy()
    expect(sidebarWidth(settings.container)).toBe("333px")
    expect(separator().getAttribute("aria-valuenow")).toBe("333")
    settings.unmount()

    window.localStorage.setItem(KEY, "999")
    expect(sidebarWidth(renderShell().container)).toBe("400px")
  })

  it("has no separator while the sidebar is collapsed or a drawer in a narrow window", () => {
    renderShell({ sidebarOpen: false })
    expect(screen.queryByRole("separator", { name: "调整侧栏宽度" })).toBeNull()
    cleanup()

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 960px)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    })
    try {
      renderShell()
      expect(screen.queryByRole("separator", { name: "调整侧栏宽度" })).toBeNull()
    } finally {
      Reflect.deleteProperty(window, "matchMedia")
    }
  })
})
