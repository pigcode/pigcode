/** 验证 ToolBlock：按优先级顺序取第一个匹配的渲染器，没有匹配时用通用行，渲染器变化时跟着重渲染。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ToolCall } from "../tool-meta"
import { resetToolOpen } from "../tool-open"
import { ToolBlock, ToolRenderersContext, type ToolRendererEntry } from "./tool-block"

afterEach(() => {
  cleanup()
  resetToolOpen()
})

const CALL: ToolCall = {
  id: "c1",
  name: "frob_widget",
  status: "completed",
  input: undefined,
  output: undefined,
}

function entry(label: string, match: (name: string) => boolean): ToolRendererEntry {
  return { matches: match, render: () => <p>{label}</p> }
}

function scoped(renderers: readonly ToolRendererEntry[], node: ReactNode) {
  return (
    <LocaleProvider locale="zh-CN">
      <ToolRenderersContext.Provider value={renderers}>{node}</ToolRenderersContext.Provider>
    </LocaleProvider>
  )
}

describe("ToolBlock", () => {
  it("uses the generic row when there are no renderers at all", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ToolBlock tool={CALL} />
      </LocaleProvider>,
    )
    expect(screen.getByText("Frob widget")).toBeTruthy()
  })

  it("uses the generic row when no renderer matches", () => {
    render(scoped([entry("other", () => false)], <ToolBlock tool={CALL} />))
    expect(screen.queryByText("other")).toBeNull()
    expect(screen.getByText("Frob widget")).toBeTruthy()
  })

  it("takes the first match and does not ask the renderers after it", () => {
    const later = vi.fn(() => true)
    render(
      scoped(
        [entry("no", () => false), entry("first", () => true), entry("later", later)],
        <ToolBlock tool={CALL} />,
      ),
    )
    expect(screen.getByText("first")).toBeTruthy()
    expect(screen.queryByText("later")).toBeNull()
    expect(later).not.toHaveBeenCalled()
  })

  it("hands over the call, the live output and whether to show the icon", () => {
    const seen = vi.fn(() => null)
    const renderer: ToolRendererEntry = { matches: () => true, render: seen }
    const { rerender } = render(scoped([renderer], <ToolBlock tool={CALL} live="out" />))
    expect(seen).toHaveBeenLastCalledWith({ tool: CALL, live: "out", showIcon: true })
    rerender(scoped([renderer], <ToolBlock tool={CALL} showIcon={false} />))
    expect(seen).toHaveBeenLastCalledWith({ tool: CALL, live: undefined, showIcon: false })
  })

  it("re-renders when the renderers change, so removing one reverts to the generic row", () => {
    const block = <ToolBlock tool={CALL} />
    const { rerender } = render(scoped([entry("plugin", () => true)], block))
    expect(screen.getByText("plugin")).toBeTruthy()
    // 同一个元素：ToolBlock 的 memo 不会因为 props 重渲染，只能靠 context。
    rerender(scoped([], block))
    expect(screen.queryByText("plugin")).toBeNull()
    expect(screen.getByText("Frob widget")).toBeTruthy()
  })
})
