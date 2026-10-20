/** 验证外壳右栏的挂载与折叠。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Shell } from "./shell"

// vitest 未开启 globals，Testing Library 不会自动清理，多测试用例需要手动卸载。
afterEach(cleanup)

describe("Shell", () => {
  it("renders the right panel when provided", () => {
    render(
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
          rightPanel={<div>right</div>}
        >
          <div>chat</div>
        </Shell>
      </LocaleProvider>,
    )
    expect(screen.getByText("right")).toBeTruthy()
  })

  it("hides the right panel when closed", () => {
    const { container } = render(
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
          rightPanel={<div>right</div>}
          rightOpen={false}
        >
          <div>chat</div>
        </Shell>
      </LocaleProvider>,
    )
    expect(screen.queryByText("right")).toBeNull()
    expect(container.querySelector(".app")?.classList.contains("has-right")).toBe(false)
  })
})
