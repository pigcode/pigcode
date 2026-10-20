/** 验证多会话 tab 栏的激活、关闭与运行状态展示。 */
// @vitest-environment jsdom
import type { ComponentProps } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Thread } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ThreadTabs } from "./thread-tabs"

afterEach(cleanup)

/** 构造测试线程；只覆盖 tab 需要的字段。 */
function thread(id: string, title: string): Thread {
  return {
    id,
    projectId: "p1",
    title,
    defaultProviderId: "fake",
    lastProviderId: null,
    lastModelId: null,
    permissionMode: "workspace-write",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    archivedAt: null,
    lastRunId: null,
  }
}

/** 渲染带 locale 的 tab 栏。 */
function renderTabs(
  props: Partial<ComponentProps<typeof ThreadTabs>> & {
    onActivate?: (threadId: string) => void
    onClose?: (threadId: string) => void
  } = {},
) {
  return render(
    <LocaleProvider locale="zh-CN">
      <ThreadTabs
        threads={[thread("t1", "First thread"), thread("t2", "Second thread")]}
        openThreadIds={["t1", "t2"]}
        activeThreadId="t1"
        statusByThread={{}}
        onActivate={() => {}}
        onClose={() => {}}
        {...props}
      />
    </LocaleProvider>,
  )
}

describe("ThreadTabs", () => {
  it("activates the clicked tab", async () => {
    const onActivate = vi.fn()
    renderTabs({ onActivate })

    await userEvent.click(screen.getByRole("tab", { name: /Second thread/ }))

    expect(onActivate).toHaveBeenCalledWith("t2")
  })

  it("exposes the running status on the tab", () => {
    const { container } = renderTabs({ statusByThread: { t2: "running" } })

    const status = container.querySelector('[data-status="running"]')
    expect(status).not.toBeNull()
    expect(status?.getAttribute("role") ?? "status").toBe("status")
  })

  it("closes a tab without activating it", async () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    renderTabs({ onActivate, onClose })

    await userEvent.click(screen.getByRole("button", { name: /关闭 Second thread/ }))

    expect(onClose).toHaveBeenCalledWith("t2")
    expect(onActivate).not.toHaveBeenCalled()
  })
})
