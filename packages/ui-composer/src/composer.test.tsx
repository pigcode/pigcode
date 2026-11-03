/** 验证 composer 的提交、清空、停止、纯文本正文、历史翻找、草稿与权限切换。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { resetComposerMemory } from "./composer-memory"

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const view = render(
    <LocaleProvider locale="zh-CN">
      <Composer onSubmit={() => {}} onStop={() => {}} {...props} />
    </LocaleProvider>,
  )
  return {
    ...view,
    editor: screen.getByRole("textbox"),
    rerenderWith: (next: Partial<ComponentProps<typeof Composer>>) =>
      view.rerender(
        <LocaleProvider locale="zh-CN">
          <Composer onSubmit={() => {}} onStop={() => {}} {...props} {...next} />
        </LocaleProvider>,
      ),
  }
}

describe("Composer", () => {
  it("submits non-empty text with the effort of the current model", async () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ onSubmit })
    await userEvent.type(editor, "hello")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("hello", { effort: null })
  })

  it("clears the editor after submitting with Enter or the send button", async () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ onSubmit })
    await userEvent.type(editor, "first")
    await userEvent.keyboard("{Enter}")
    expect(editor.textContent).toBe("")

    await userEvent.type(editor, "second")
    await userEvent.click(screen.getByRole("button", { name: "发送" }))
    expect(onSubmit.mock.calls.map((call) => call[0])).toEqual(["first", "second"])
    expect(editor.textContent).toBe("")
    expect(screen.getByRole("button", { name: "发送" }).getAttribute("aria-disabled")).toBe("true")
  })

  it("keeps markdown markers as typed instead of turning them into formatting", async () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ onSubmit, smartPunctuation: false })
    await userEvent.type(editor, "make **this** bold and `code` stay")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("make **this** bold and `code` stay", { effort: null })
  })

  it("adds a line break with Shift+Enter and sends single newlines", async () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ onSubmit })
    await userEvent.type(editor, "line one")
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}")
    // userEvent.type 会先点击编辑器、挪动光标；这里接着键入。
    await userEvent.keyboard("line two")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("line one\nline two", { effort: null })
  })

  it("pastes plain text only", async () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ onSubmit })
    await userEvent.click(editor)
    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) =>
          type === "text/plain" ? "first line\nsecond line" : "<b>first line</b><br>second line",
      },
    })
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("first line\nsecond line", { effort: null })
  })

  it("brings back sent messages with ↑ and ↓ in an empty editor", async () => {
    const { editor } = renderComposer()
    await userEvent.type(editor, "older")
    await userEvent.keyboard("{Enter}")
    await userEvent.type(editor, "newer")
    await userEvent.keyboard("{Enter}")

    await userEvent.keyboard("{ArrowUp}")
    expect(editor.textContent).toBe("newer")
    await userEvent.keyboard("{ArrowUp}")
    expect(editor.textContent).toBe("older")
    await userEvent.keyboard("{ArrowDown}")
    expect(editor.textContent).toBe("newer")
    await userEvent.keyboard("{ArrowDown}")
    expect(editor.textContent).toBe("")
  })

  it("keeps a separate draft for each thread", async () => {
    const view = renderComposer({ draftKey: "thread-a" })
    await userEvent.type(view.editor, "draft for a")
    view.rerenderWith({ draftKey: "thread-b" })
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe(""))
    await userEvent.type(screen.getByRole("textbox"), "draft for b")
    view.rerenderWith({ draftKey: "thread-a" })
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe("draft for a"))
    view.rerenderWith({ draftKey: "thread-b" })
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe("draft for b"))
  })

  it("lists / commands that are available now, one per name", async () => {
    const user = userEvent.setup()
    let ready = false
    const { editor } = renderComposer({
      commands: [
        { id: "a", label: "/debug", description: "First", run: () => {} },
        { id: "b", label: "/debug", description: "Second", run: () => {} },
        {
          id: "c",
          label: "/dev",
          description: "Dev server",
          available: () => ready,
          run: () => {},
        },
      ],
    })

    await user.click(editor)
    await user.keyboard("/d")
    const list = await screen.findByRole("listbox", { name: "命令" })
    expect(list.textContent).toContain("First")
    expect(list.textContent).not.toContain("Second")
    expect(list.textContent).not.toContain("Dev server")

    // available() 在每次弹出建议时重新判断。
    await user.keyboard("{Escape}{Control>}a{/Control}{Backspace}")
    ready = true
    await user.keyboard("/d")
    expect((await screen.findByRole("listbox", { name: "命令" })).textContent).toContain(
      "Dev server",
    )
  })

  it("keeps the typed text when the chosen / command went away while the list was open", async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    const { editor, rerenderWith } = renderComposer({
      commands: [{ id: "a", label: "/debug", description: "Debug", run }],
    })

    await user.click(editor)
    await user.keyboard("/de")
    await screen.findByRole("listbox", { name: "命令" })
    // 例如它的插件在列表打开期间被停用。
    rerenderWith({ commands: [] })
    await user.keyboard("{Enter}")

    expect(run).not.toHaveBeenCalled()
    expect(editor.textContent).toContain("/de")
  })

  it("does not submit empty content", async () => {
    const onSubmit = vi.fn()
    const { editor } = renderComposer({ onSubmit })
    await userEvent.click(editor)
    await userEvent.keyboard("{Enter}")
    await userEvent.click(screen.getByRole("button", { name: "发送" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "发送" }).getAttribute("aria-disabled")).toBe("true")
  })

  it("shows stop while running and calls onStop", async () => {
    const onStop = vi.fn()
    renderComposer({ onStop, running: true })
    await userEvent.click(screen.getByRole("button", { name: "中断" }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("cycles the permission mode with Shift+Tab, skipping full access", async () => {
    const onPermissionMode = vi.fn()
    const { editor, rerenderWith } = renderComposer({ onPermissionMode })
    await userEvent.click(editor)
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    expect(onPermissionMode).toHaveBeenLastCalledWith("plan")

    rerenderWith({ onPermissionMode, permissionMode: "read-only" })
    await userEvent.click(screen.getByRole("textbox"))
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    expect(onPermissionMode).toHaveBeenLastCalledWith("workspace-write")

    rerenderWith({ onPermissionMode, permissionMode: "workspace-write", canPlan: false })
    await userEvent.click(screen.getByRole("textbox"))
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    expect(onPermissionMode).toHaveBeenLastCalledWith("read-only")
  })

  it("asks before turning on full access from the permission menu", async () => {
    const onPermissionMode = vi.fn()
    renderComposer({ onPermissionMode })
    const chip = screen.getByRole("button", { name: "权限: 每次询问" })
    await userEvent.click(chip)
    await userEvent.click(await screen.findByRole("menuitem", { name: /只读/ }))
    expect(onPermissionMode).toHaveBeenLastCalledWith("read-only")

    await userEvent.click(chip)
    await userEvent.click(await screen.findByRole("menuitem", { name: /完全访问/ }))
    expect(onPermissionMode).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("dialog", { name: "开启完全访问？" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "开启完全访问" }))
    expect(onPermissionMode).toHaveBeenLastCalledWith("danger-full-access")
  })
})
