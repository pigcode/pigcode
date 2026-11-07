/** 验证输入框上方的上下文附件：加上、同一个 id 替换、移除、和文字一起发出、禁用时不接收、按会话保留，以及从外面预填的会话。 */
// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { requestComposerContext, withContexts } from "./composer-context"
import { prefillComposer, resetComposerMemory } from "./composer-memory"

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  render(
    <LocaleProvider locale="zh-CN">
      <Composer onSubmit={() => {}} onStop={() => {}} {...props} />
    </LocaleProvider>,
  )
  return screen.getByRole("textbox")
}

const element = (id: string, label: string) => ({
  id,
  label,
  markdown: `### ${label}\n\n- selector: \`${id}\``,
})

describe("composer contexts", () => {
  it("joins the typed text and the attached blocks", () => {
    expect(withContexts("看看这个", [element("a", "A"), element("b", "B")])).toBe(
      "看看这个\n\n### A\n\n- selector: `a`\n\n### B\n\n- selector: `b`",
    )
    expect(withContexts("", [element("a", "A")])).toBe("### A\n\n- selector: `a`")
  })

  it("sends attached elements on their own and clears them afterwards", async () => {
    const onSubmit = vi.fn()
    renderComposer({ onSubmit })
    const send = screen.getByRole("button", { name: "发送" })
    expect(send.getAttribute("aria-disabled")).toBe("true")
    act(() => requestComposerContext(element("form > button", "<button> 登录")))
    expect(screen.getByText("<button> 登录")).toBeTruthy()
    expect(send.getAttribute("aria-disabled")).toBeNull()
    // 带着附件时正文挪到上面，附件排在正文上方，按钮留在下面一排。
    expect(document.querySelector(".composer")?.classList.contains("is-expanded")).toBe(true)
    await userEvent.click(send)
    expect(onSubmit).toHaveBeenCalledWith("### <button> 登录\n\n- selector: `form > button`", {
      effort: null,
    })
    expect(screen.queryByText("<button> 登录")).toBeNull()
  })

  it("replaces an element picked twice, removes chips, and puts the rest after the text", async () => {
    const onSubmit = vi.fn()
    const editor = renderComposer({ onSubmit })
    act(() => {
      requestComposerContext(element("a", "旧的"))
      requestComposerContext(element("b", "保留"))
      requestComposerContext(element("a", "新的"))
      requestComposerContext(element("c", "移除"))
    })
    expect(screen.queryByText("旧的")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "移除移除" }))
    await userEvent.type(editor, "改一下")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith(
      "改一下\n\n### 保留\n\n- selector: `b`\n\n### 新的\n\n- selector: `a`",
      { effort: null },
    )
  })

  it("opens a prefilled conversation with its text, attachments and the cursor at the end", async () => {
    prefillComposer("thread-new", {
      text: "帮我创建一个 Pigcode 插件：",
      contexts: [element("guide", "Pigcode 插件创建指南")],
    })
    const onSubmit = vi.fn()
    const editor = renderComposer({ onSubmit, draftKey: "thread-new" })
    expect(editor.textContent).toBe("帮我创建一个 Pigcode 插件：")
    expect(screen.getByText("Pigcode 插件创建指南")).toBeTruthy()
    // 光标停在预填文字的末尾：不用点输入框，直接接着写。
    await vi.waitFor(() => expect(document.activeElement).toBe(editor))
    await userEvent.type(editor, "统计字数", { skipClick: true })
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith(
      "帮我创建一个 Pigcode 插件：统计字数\n\n### Pigcode 插件创建指南\n\n- selector: `guide`",
      { effort: null },
    )
  })

  it("fills an input that is already open, but leaves other conversations' inputs alone", async () => {
    const editor = renderComposer({ draftKey: "new-thread" })
    await userEvent.type(editor, "原来的字")
    act(() => prefillComposer("other-thread", { text: "别处的预填" }))
    expect(editor.textContent).toBe("原来的字")

    act(() => prefillComposer("new-thread", { text: "介绍一下这个项目" }))
    expect(editor.textContent).toBe("介绍一下这个项目")
    await vi.waitFor(() => expect(document.activeElement).toBe(editor))
  })

  it("keeps each conversation's attachments when switching between them", () => {
    prefillComposer("thread-a", { text: "", contexts: [element("a", "A 的附件")] })
    const view = render(
      <LocaleProvider locale="zh-CN">
        <Composer onSubmit={() => {}} onStop={() => {}} draftKey="thread-a" />
      </LocaleProvider>,
    )
    expect(screen.getByText("A 的附件")).toBeTruthy()
    view.rerender(
      <LocaleProvider locale="zh-CN">
        <Composer onSubmit={() => {}} onStop={() => {}} draftKey="thread-b" />
      </LocaleProvider>,
    )
    expect(screen.queryByText("A 的附件")).toBeNull()
    view.rerender(
      <LocaleProvider locale="zh-CN">
        <Composer onSubmit={() => {}} onStop={() => {}} draftKey="thread-a" />
      </LocaleProvider>,
    )
    expect(screen.getByText("A 的附件")).toBeTruthy()
  })

  it("ignores attachments while the input is disabled", () => {
    renderComposer({ disabled: true })
    act(() => requestComposerContext(element("a", "不会出现")))
    expect(screen.queryByText("不会出现")).toBeNull()
  })
})
