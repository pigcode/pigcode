/** 验证 PR 面板：空状态、创建表单与状态徽标。 */
// @vitest-environment jsdom
import { cleanup, render as renderUi, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { PrPanel } from "./pr-panel"

/** 组件文案来自 locale；测试按中文界面渲染。 */
function render(ui: ReactElement) {
  return renderUi(ui, {
    wrapper: ({ children }) => <LocaleProvider locale="zh-CN">{children}</LocaleProvider>,
  })
}

/** 测试用的 PR 摘要。 */
const PULL_REQUEST = {
  number: 42,
  url: "https://github.com/pigcode/pigcode/pull/42",
  state: "OPEN" as const,
  title: "Add pull request panel",
  headRefName: "feat/pr",
  baseRefName: "main",
}

afterEach(cleanup)

describe("PrPanel", () => {
  it("shows an empty state and submits the create form", async () => {
    const onCreate = vi.fn()
    render(<PrPanel pullRequest={null} onCreate={onCreate} />)

    expect(screen.getByText("还没有 PR")).toBeTruthy()
    await userEvent.type(screen.getByLabelText("标题"), "Add feature")
    await userEvent.type(screen.getByLabelText("说明"), "Why it matters")
    await userEvent.type(screen.getByLabelText("合并到"), "main")
    await userEvent.click(screen.getByRole("button", { name: "创建 PR" }))

    expect(onCreate).toHaveBeenCalledWith({
      title: "Add feature",
      body: "Why it matters",
      base: "main",
    })
  })

  it("requires a non-empty title before creating", async () => {
    const onCreate = vi.fn()
    render(<PrPanel pullRequest={null} onCreate={onCreate} />)

    const submit = screen.getByRole("button", { name: "创建 PR" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText("标题"), "   ")
    expect(submit.disabled).toBe(true)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("shows the pull request status badge and link", () => {
    render(<PrPanel pullRequest={PULL_REQUEST} onCreate={vi.fn()} />)

    expect(screen.getByText("#42")).toBeTruthy()
    expect(screen.getByText("OPEN")).toBeTruthy()
    expect(screen.getByText("feat/pr → main")).toBeTruthy()
    const link = screen.getByRole("link", { name: PULL_REQUEST.url })
    expect(link.getAttribute("href")).toBe(PULL_REQUEST.url)
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("explains known host errors and keeps the raw message behind a toggle", async () => {
    const raw = "GitHub CLI is not authenticated. Run `gh auth login` first. (not logged in)"
    render(
      <PrPanel
        pullRequest={null}
        onCreate={vi.fn()}
        error={{ code: "GH_NOT_AUTHENTICATED", message: raw }}
      />,
    )

    expect(screen.getByText(/gh 还没登录/)).toBeTruthy()
    expect(screen.queryByText(raw)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "详细信息" }))
    expect(screen.getByText(raw)).toBeTruthy()
  })

  it("shows other host errors as they are", () => {
    render(
      <PrPanel
        pullRequest={null}
        onCreate={vi.fn()}
        error={{ code: "COMMAND_FAILED", message: "gh command failed" }}
      />,
    )

    expect(screen.getByText("gh command failed")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "详细信息" })).toBeNull()
  })

  it("submits draft flag when creating as draft", async () => {
    const onCreate = vi.fn()
    render(<PrPanel pullRequest={null} onCreate={onCreate} />)

    await userEvent.type(screen.getByLabelText("标题"), "WIP feature")
    await userEvent.click(screen.getByRole("checkbox", { name: "创建为草稿（Draft）" }))
    await userEvent.click(screen.getByRole("button", { name: "创建 PR" }))

    expect(onCreate).toHaveBeenCalledWith({
      title: "WIP feature",
      draft: true,
    })
  })

  it("renders draft badge and marks draft PR as ready", async () => {
    const onReady = vi.fn()
    render(
      <PrPanel
        pullRequest={{ ...PULL_REQUEST, isDraft: true }}
        onCreate={vi.fn()}
        onReady={onReady}
        onClose={vi.fn()}
        onComment={vi.fn()}
      />,
    )

    expect(screen.getByText("草稿")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "合并 PR" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "标记为 Ready" }))
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it("confirms before merging with selected method and deleteBranch", async () => {
    const onMerge = vi.fn()
    render(
      <PrPanel
        pullRequest={{ ...PULL_REQUEST, isDraft: false }}
        onCreate={vi.fn()}
        onMerge={onMerge}
        onClose={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole("combobox", { name: "合并方式" }))
    await userEvent.click(await screen.findByRole("option", { name: "Rebase 变基合并" }))
    await userEvent.click(screen.getByRole("checkbox", { name: "合并后删除源分支" }))
    await userEvent.click(screen.getByRole("button", { name: "合并 PR" }))
    expect(onMerge).not.toHaveBeenCalled()
    expect(screen.getByText("确认合并这个 PR？")).toBeTruthy()

    await userEvent.click(screen.getByRole("button", { name: "确认合并" }))
    expect(onMerge).toHaveBeenCalledWith({ method: "rebase", deleteBranch: true })
  })

  it("confirms close, allows reopen on closed PR, and handles comments", async () => {
    const onClose = vi.fn()
    const onReopen = vi.fn()
    const onComment = vi.fn()
    const { rerender } = render(
      <PrPanel
        pullRequest={PULL_REQUEST}
        onCreate={vi.fn()}
        onClose={onClose}
        onComment={onComment}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "关闭 PR" }))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "确认关闭" }))
    expect(onClose).toHaveBeenCalledTimes(1)

    const commentBox = screen.getByLabelText("发表评论") as HTMLTextAreaElement
    await userEvent.type(commentBox, "LGTM!")
    await userEvent.click(screen.getByRole("button", { name: "发送评论" }))
    expect(onComment).toHaveBeenCalledWith("LGTM!")
    expect(commentBox.value).toBe("")
    expect(screen.getByText("已发表评论")).toBeTruthy()

    rerender(
      <PrPanel
        pullRequest={{ ...PULL_REQUEST, state: "CLOSED" }}
        onCreate={vi.fn()}
        onReopen={onReopen}
        onComment={onComment}
      />,
    )
    await userEvent.click(screen.getByRole("button", { name: "重新打开 PR" }))
    expect(onReopen).toHaveBeenCalledTimes(1)
  })
})
