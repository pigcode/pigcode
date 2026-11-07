/** 验证草稿换归属：还挂着的输入框交出正在写的文字和附件，新键的输入框接着显示，光标在末尾。 */
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { requestComposerContext } from "./composer-context"
import { moveComposerDraft, prefillComposer, resetComposerMemory } from "./composer-memory"

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

const composer = (draftKey: string) => (
  <LocaleProvider locale="zh-CN">
    <Composer onSubmit={() => {}} onStop={() => {}} draftKey={draftKey} />
  </LocaleProvider>
)

const attachment = { id: "guide", label: "插件指南", markdown: "### 插件指南" }

describe("moveComposerDraft", () => {
  it("takes what is being typed and attached in a mounted input over to the new key", async () => {
    const { rerender } = render(composer("new-thread"))
    await userEvent.type(screen.getByRole("textbox"), "修一下登录页")
    act(() => requestComposerContext(attachment))
    expect(screen.getByText("插件指南")).toBeTruthy()

    act(() => moveComposerDraft("new-thread", "t1"))
    expect(screen.getByRole("textbox").textContent).toBe("")
    expect(screen.queryByText("插件指南")).toBeNull()

    rerender(composer("t1"))
    expect(screen.getByRole("textbox").textContent).toBe("修一下登录页")
    expect(screen.getByText("插件指南")).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.closest(".tiptap")).not.toBeNull())
    await userEvent.keyboard("，再补测试")
    expect(screen.getByRole("textbox").textContent).toBe("修一下登录页，再补测试")

    rerender(composer("new-thread"))
    expect(screen.getByRole("textbox").textContent).toBe("")
    expect(screen.queryByText("插件指南")).toBeNull()
  })

  it("fills an input already showing the new key straight away", () => {
    prefillComposer("new-thread", { text: "接着写" })
    render(composer("t1"))
    expect(screen.getByRole("textbox").textContent).toBe("")
    act(() => moveComposerDraft("new-thread", "t1"))
    expect(screen.getByRole("textbox").textContent).toBe("接着写")
  })

  it("leaves the new key alone when there is nothing to carry over", async () => {
    render(composer("t1"))
    await userEvent.type(screen.getByRole("textbox"), "已经写的")
    act(() => moveComposerDraft("new-thread", "t1"))
    expect(screen.getByRole("textbox").textContent).toBe("已经写的")
  })
})
