/** 验证命令面板的过滤、键盘执行与分组。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { CommandPalette } from "./command-palette"

afterEach(cleanup)

/** 渲染一个打开的面板；回调由测试注入。 */
function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const onClose = vi.fn()
  const onNewThread = vi.fn()
  const onPlugins = vi.fn()
  render(
    <LocaleProvider locale="zh-CN">
      <CommandPalette
        open
        onClose={onClose}
        projects={[]}
        threads={[]}
        activeThreadId={null}
        onNewThread={onNewThread}
        onOpenThread={() => {}}
        onAddProject={() => {}}
        onSettings={() => {}}
        onPlugins={onPlugins}
        {...overrides}
      />
    </LocaleProvider>,
  )
  return { onClose, onNewThread, onPlugins }
}

describe("CommandPalette", () => {
  it("filters commands by label and runs the selected one", async () => {
    const user = userEvent.setup()
    const { onPlugins } = renderPalette()

    await user.type(screen.getByLabelText("搜索或执行命令…"), "插件")
    const item = screen.getByRole("option", { name: /插件/ })
    await user.click(item)

    expect(onPlugins).toHaveBeenCalledTimes(1)
  })

  it("runs the first command on Enter", async () => {
    const user = userEvent.setup()
    const { onNewThread } = renderPalette()

    await user.keyboard("{Enter}")

    expect(onNewThread).toHaveBeenCalledTimes(1)
  })

  it("closes on Escape", async () => {
    const user = userEvent.setup()
    const { onClose } = renderPalette()

    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("lists the same threads as the sidebar: no archived ones, none from removed projects", () => {
    const thread = (id: string, projectId: string, archivedAt: string | null = null) => ({
      id,
      projectId,
      title: `Thread ${id}`,
      defaultAgentId: "fake",
      lastAgentId: null,
      lastModelId: null,
      permissionMode: "workspace-write" as const,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      archivedAt,
      lastRunId: null,
    })
    renderPalette({
      projects: [
        { id: "p1", rootPath: "/tmp/p1", name: "p1", createdAt: "2026-10-20T00:00:00.000Z" },
      ],
      threads: [
        thread("t1", "p1"),
        thread("t2", "p1", "2026-10-21T00:00:00.000Z"),
        thread("t3", "removed"),
      ],
    })

    expect(screen.getByRole("option", { name: /Thread t1/ })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /Thread t2/ })).toBeNull()
    expect(screen.queryByRole("option", { name: /Thread t3/ })).toBeNull()
  })
})
