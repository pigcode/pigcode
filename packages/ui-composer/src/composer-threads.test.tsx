/** 输入框 @ 引用会话（#81）：会话一组在文件前面，选中后插入会话标记，发送时带上结构化引用。 */
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { requestComposerThreadMention } from "./composer-mention"
import { resetComposerMemory } from "./composer-memory"
import { matchThreads, type ComposerThreadOption } from "./composer-threads"

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

const THREADS: ComposerThreadOption[] = [
  { id: "t1", title: "重构解析器", projectName: "app", sameProject: true, archived: false },
  { id: "t2", title: "修登录", projectName: "app", sameProject: true, archived: false },
  { id: "t3", title: "旧的解析器方案", projectName: "app", sameProject: true, archived: true },
  { id: "t4", title: "解析器文档", projectName: "docs", sameProject: false, archived: false },
]

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  render(
    <LocaleProvider locale="zh-CN">
      <Composer onSubmit={() => {}} onStop={() => {}} {...props} />
    </LocaleProvider>,
  )
  return screen.getByRole("textbox")
}

describe("matchThreads", () => {
  it("lists this project's live threads until the user types", () => {
    expect(matchThreads(THREADS, "").map((thread) => thread.id)).toEqual(["t1", "t2"])
  })

  it("searches every project and archived threads by title", () => {
    expect(matchThreads(THREADS, "解析器").map((thread) => thread.id)).toEqual(["t1", "t3", "t4"])
    expect(matchThreads(THREADS, "ind")).toEqual([])
  })
})

describe("composer thread mentions", () => {
  it("references a thread with @ and sends it as a structured reference", async () => {
    const onSubmit = vi.fn()
    const editor = renderComposer({
      onSubmit,
      threads: THREADS,
      files: async () => ["docs/解析器说明.md"],
    })
    await userEvent.type(editor, "接着 @解析器")
    const list = await screen.findByRole("listbox", { name: "引用" })
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(4))
    const options = within(list).getAllByRole("option")
    // 会话在前，文件在后；其他项目的会话写着项目名，已归档的标出来。
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("重构解析器"),
      expect.stringContaining("已归档"),
      expect.stringContaining("docs"),
      expect.stringContaining("解析器说明.md"),
    ])
    expect(within(list).getByText("会话")).toBeTruthy()
    expect(within(list).getByText("文件")).toBeTruthy()

    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(editor.querySelector('.mention-chip[data-kind="thread"]')?.textContent).toBe(
      "@重构解析器",
    )
    await userEvent.keyboard("做完{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("接着 @重构解析器 做完", {
      effort: null,
      references: [{ kind: "thread", threadId: "t1", title: "重构解析器" }],
    })
  })

  it("keeps the file-only menu as it was when no thread matches", async () => {
    const editor = renderComposer({ threads: THREADS, files: async () => ["src/index.ts"] })
    await userEvent.type(editor, "@ind")
    const list = await screen.findByRole("listbox", { name: "文件" })
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1))
    expect(within(list).queryByText("会话")).toBeNull()
  })

  it("inserts a thread from outside the composer, like the sidebar menu does", async () => {
    const onSubmit = vi.fn()
    const editor = renderComposer({ onSubmit })
    act(() => requestComposerThreadMention("t2", "修登录"))
    await waitFor(() => expect(editor.querySelector(".mention-chip")?.textContent).toBe("@修登录"))
    // jsdom 里插入后焦点不在编辑器上，直接点发送。
    await userEvent.click(screen.getByRole("button", { name: "发送" }))
    expect(onSubmit).toHaveBeenCalledWith("@修登录", {
      effort: null,
      references: [{ kind: "thread", threadId: "t2", title: "修登录" }],
    })
  })
})
