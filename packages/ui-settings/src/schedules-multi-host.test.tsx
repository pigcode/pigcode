/** 验证定时任务页跨主机聚合徽标、离线只读提示与新建任务选择运行主机。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { HostSummary, Project, Schedule } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SchedulesPage } from "./schedules-page"

const LOCAL_HOST: HostSummary = {
  id: "local",
  name: "Studio Mac",
  hostKey: "L".repeat(43),
  kind: "local",
  badgeColor: "blue",
  status: "connected",
  channel: "local",
  latencyMs: 0,
  lanAddresses: [],
  relayAddress: null,
  lastConnectedAt: 1000,
  lastError: null,
}

const OFFLINE_NAS: HostSummary = {
  id: "nas-1",
  name: "Home NAS",
  hostKey: "N".repeat(43),
  kind: "headless",
  badgeColor: "green",
  status: "offline",
  channel: "relay",
  latencyMs: null,
  lanAddresses: [],
  relayAddress: "wss://relay.example/ws/v1/connect",
  lastConnectedAt: 1000,
  lastError: "offline",
}

const ONLINE_SERVER: HostSummary = {
  ...OFFLINE_NAS,
  id: "srv-2",
  name: "Cloud VM",
  status: "connected",
}

const SAMPLE_PROJECT: Project = {
  id: "p1",
  name: "app",
  rootPath: "/srv/app",
  createdAt: "2026-11-28T00:00:00.000Z",
}

const SAMPLE_SCHEDULE: Schedule = {
  id: "s1",
  title: "Nightly Audit",
  prompt: "check repo",
  draft: null,
  rule: { kind: "daily", time: "09:00" },
  endsAt: null,
  enabled: true,
  target: { kind: "project", projectId: "p1", execution: { permissionMode: "full-access" } },
  status: "active",
  runCount: 2,
  lastRunAt: null,
  lastRunId: null,
  nextRunAt: "2026-11-29T09:00:00.000Z",
  createdAt: "2026-11-28T00:00:00.000Z",
  updatedAt: "2026-11-28T00:00:00.000Z",
}

afterEach(() => cleanup())

describe("Multi-host SchedulesPage", () => {
  it("shows host badges on schedule cards, offline readonly notice when editing offline schedule, and lets new tasks pick target host", async () => {
    const onTargetHostChange = vi.fn()
    const { rerender } = render(
      <LocaleProvider locale="zh-CN">
        <SchedulesPage
          schedules={[SAMPLE_SCHEDULE]}
          threads={[]}
          projects={[SAMPLE_PROJECT]}
          hosts={[LOCAL_HOST, OFFLINE_NAS]}
          targetHostId="local"
          onTargetHostChange={onTargetHostChange}
          scheduleHosts={{ s1: OFFLINE_NAS }}
          agentOptions={{ agents: [], catalog: {} }}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onRunNow={vi.fn()}
          onLoadRuns={vi.fn()}
          onDeleteRun={vi.fn()}
        />
      </LocaleProvider>,
    )

    expect(screen.getByText(/Home NAS/)).toBeTruthy()
    expect(screen.getByText(/离线/)).toBeTruthy()

    // Click offline schedule card -> shows offline read-only banner in ScheduleEditor.
    await userEvent.click(screen.getByRole("button", { name: "Nightly Audit" }))
    expect(screen.getByText(/目标主机当前离线/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true)

    // Rerender with online hosts -> creating a schedule offers target host picker.
    rerender(
      <LocaleProvider locale="zh-CN">
        <SchedulesPage
          schedules={[]}
          threads={[]}
          projects={[SAMPLE_PROJECT]}
          hosts={[LOCAL_HOST, ONLINE_SERVER]}
          targetHostId="local"
          onTargetHostChange={onTargetHostChange}
          agentOptions={{ agents: [], catalog: {} }}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onRunNow={vi.fn()}
          onLoadRuns={vi.fn()}
          onDeleteRun={vi.fn()}
        />
      </LocaleProvider>,
    )

    await userEvent.click(screen.getByRole("button", { name: "新建任务" }))
    await userEvent.click(screen.getByRole("button", { name: "运行主机" }))
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Cloud VM/ }))
    expect(onTargetHostChange).toHaveBeenCalledWith("srv-2")
  })
})
