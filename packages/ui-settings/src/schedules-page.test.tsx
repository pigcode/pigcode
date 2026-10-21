/** 验证定时任务设置页的列表、创建、启停、立即运行与删除。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Schedule } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { SchedulesPage } from "./schedules-page"

/** 一条已启用的定时任务。 */
const schedule: Schedule = {
  id: "sch_1",
  threadId: "th_1",
  prompt: "每日汇总",
  intervalSeconds: 60,
  enabled: true,
  nextRunAt: "2026-10-20T00:01:00.000Z",
  lastRunAt: null,
  lastRunId: null,
  createdAt: "2026-10-20T00:00:00.000Z",
}

/** 渲染带 locale 的页面。 */
function renderPage(overrides: Partial<Parameters<typeof SchedulesPage>[0]> = {}) {
  const props = {
    schedules: [schedule],
    threads: [{ id: "th_1", title: "Sprint" }],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onRunNow: vi.fn(),
    ...overrides,
  }
  render(
    <LocaleProvider locale="zh-CN">
      <SchedulesPage {...props} />
    </LocaleProvider>,
  )
  return props
}

afterEach(() => {
  cleanup()
})

describe("SchedulesPage", () => {
  it("lists schedules and creates a new one", async () => {
    const props = renderPage()
    expect(screen.getByText("每日汇总")).toBeTruthy()
    expect(screen.getAllByText(/Sprint/).length).toBeGreaterThan(0)

    await userEvent.type(screen.getByLabelText("任务内容"), "新任务")
    const interval = screen.getByLabelText("间隔（秒）")
    await userEvent.clear(interval)
    await userEvent.type(interval, "30")
    await userEvent.click(screen.getByRole("button", { name: "创建任务" }))

    expect(props.onCreate).toHaveBeenCalledWith({
      threadId: "th_1",
      prompt: "新任务",
      intervalSeconds: 30,
      enabled: true,
    })
  })

  it("toggles, runs immediately and deletes a schedule", async () => {
    const props = renderPage()

    await userEvent.click(screen.getByRole("switch", { name: /启用/ }))
    expect(props.onUpdate).toHaveBeenCalledWith("sch_1", { enabled: false })

    await userEvent.click(screen.getByRole("button", { name: "立即运行" }))
    expect(props.onRunNow).toHaveBeenCalledWith("sch_1")

    await userEvent.click(screen.getByRole("button", { name: "删除" }))
    expect(props.onDelete).toHaveBeenCalledWith("sch_1")
  })

  it("shows the empty state without schedules", () => {
    renderPage({ schedules: [] })
    expect(screen.getByText("还没有定时任务")).toBeTruthy()
  })
})
