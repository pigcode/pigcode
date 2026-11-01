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

    expect(screen.getByText("还没有关联的 Pull Request")).toBeTruthy()
    await userEvent.type(screen.getByLabelText("标题"), "Add feature")
    await userEvent.type(screen.getByLabelText("描述"), "Why it matters")
    await userEvent.type(screen.getByLabelText("目标分支"), "main")
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

    expect(screen.getByText(/GitHub CLI（gh）还没有登录/)).toBeTruthy()
    expect(screen.queryByText(raw)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "原始信息" }))
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
    expect(screen.queryByRole("button", { name: "原始信息" })).toBeNull()
  })
})
