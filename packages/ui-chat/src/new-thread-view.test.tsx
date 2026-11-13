/** 验证新会话草稿页：按时段的问候、项目选择、建议预填、发送，以及还没有项目时的样子。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetComposerMemory } from "@pigcode/ui-composer"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { NewThreadView, greetingKey } from "./new-thread-view"

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

const projects = [
  { id: "p1", name: "pigcode", rootPath: "/work/pigcode" },
  { id: "p2", name: "docs", rootPath: "/work/docs" },
]

function renderView(props: Partial<ComponentProps<typeof NewThreadView>> = {}) {
  const handlers = {
    onSelectProject: vi.fn(),
    onAddProject: vi.fn(),
    onSelectModel: vi.fn(),
    onPermissionMode: vi.fn(),
    onSubmit: vi.fn(),
  }
  render(
    <LocaleProvider locale="zh-CN">
      <NewThreadView
        projects={projects}
        projectId="p1"
        draftKey="new-thread"
        agentId={null}
        modelId={null}
        permissionMode="full-access"
        {...handlers}
        {...props}
      />
    </LocaleProvider>,
  )
  return handlers
}

describe("NewThreadView", () => {
  it("greets by the time of day, counting the small hours as night", () => {
    const at = (hour: number) => greetingKey(new Date(2026, 10, 7, hour, 30))
    expect(at(3)).toBe("newThread.greeting.night")
    expect(at(8)).toBe("newThread.greeting.morning")
    expect(at(12)).toBe("newThread.greeting.noon")
    expect(at(15)).toBe("newThread.greeting.afternoon")
    expect(at(20)).toBe("newThread.greeting.evening")
    expect(at(23)).toBe("newThread.greeting.night")
  })

  it("shows the draft's project above the input and switches to another one", async () => {
    const { onSelectProject } = renderView()
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/接下来做什么？$/)
    await userEvent.click(screen.getByRole("button", { name: "会话所在的项目: pigcode" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /docs/ }))
    expect(onSelectProject).toHaveBeenCalledWith("p2")
  })

  it("adds a project from the project menu", async () => {
    const { onAddProject } = renderView()
    await userEvent.click(screen.getByRole("button", { name: "会话所在的项目: pigcode" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "添加项目…" }))
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it("fills the input from a suggestion without sending it", async () => {
    const { onSubmit } = renderView()
    await userEvent.click(screen.getByRole("button", { name: "审查改动" }))
    expect(screen.getByRole("textbox").textContent).toBe(
      "审查当前还没提交的改动，指出可能的 bug、风险和可以改进的地方。",
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("hands the first message to the container", async () => {
    const { onSubmit } = renderView()
    await userEvent.type(screen.getByRole("textbox"), "修一下登录页")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("修一下登录页", { effort: null })
  })

  it("asks for a project first when there is none", async () => {
    const { onAddProject } = renderView({ projects: [], projectId: null })
    expect(screen.getByText(/先添加一个项目/)).toBeTruthy()
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("false")
    expect(screen.queryByRole("group", { name: "可以这样开始" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "添加项目" }))
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })
})
