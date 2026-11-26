// @vitest-environment jsdom
/** 验证底部终端多标签恢复与 useTerminalRecovery 自动还原（#85）。 */
import { useState } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import type { PanelSurfaceState } from "@pigcode/ui-workbench"

vi.mock("@pigcode/ui-workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pigcode/ui-workbench")>()
  const React = await import("react")
  const { createFakeTerminalView } = await import("./terminal-recovery.fixtures")
  return { ...actual, TerminalView: createFakeTerminalView(React) }
})

import { TerminalDrawer } from "./terminal-drawer"
import type { TerminalSession } from "./terminal-surface"
import { createTestConnection, resetWrittenByMount } from "./terminal-recovery.fixtures"
import { useTerminalRecovery } from "./use-terminal-recovery"

afterEach(() => {
  cleanup()
  resetWrittenByMount()
})

describe("TerminalDrawer multi-tab recovery (#85)", () => {
  it("restores multiple active tabs via attach without opening duplicates, and opens a new tab on '+'", async () => {
    const recovered: TerminalSession[] = [
      {
        id: "term_a",
        threadId: "th_1",
        projectId: "proj_1",
        cols: 80,
        rows: 24,
        shell: "zsh",
        cwd: "/repo/alpha",
        cursor: 5,
        placement: "drawer",
        createdAt: "2026-11-25T10:00:00.000Z",
      },
      {
        id: "term_b",
        threadId: "th_1",
        projectId: "proj_1",
        cols: 80,
        rows: 24,
        shell: "fish",
        cwd: "/repo/beta",
        cursor: 3,
        placement: "drawer",
        createdAt: "2026-11-25T10:01:00.000Z",
      },
    ]

    const { connection, calls } = await createTestConnection((method, params) => {
      if (method === "terminal.attach") {
        const session = recovered.find((item) => item.id === params.terminalId)!
        return {
          session,
          replay: `replay:${session.id}`,
          cursor: session.cursor ?? 0,
          truncated: false,
        }
      }
      if (method === "terminal.open") {
        return {
          id: "term_new",
          threadId: "th_1",
          projectId: "proj_1",
          cols: 96,
          rows: 28,
          shell: "zsh",
          cwd: "/repo/alpha",
          cursor: 0,
          placement: "drawer",
          createdAt: "2026-11-25T10:02:00.000Z",
        }
      }
      return undefined
    })

    render(
      <LocaleProvider locale="zh-CN">
        <TerminalDrawer
          connection={connection}
          owner={{ threadId: "th_1" }}
          open
          onClose={() => undefined}
          initialSessions={recovered}
        />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(calls.filter((call) => call.method === "terminal.attach")).toHaveLength(2)
    })
    expect(calls.filter((call) => call.method === "terminal.open")).toHaveLength(0)
    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getByRole("tab", { name: "alpha" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "beta" })).toBeTruthy()

    // 点击「+」才调用 terminal.open 新开第三个终端。
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }))
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "terminal.open")).toHaveLength(1)
    })
    expect(calls.find((call) => call.method === "terminal.open")).toEqual({
      method: "terminal.open",
      params: { threadId: "th_1", cols: 96, rows: 28, placement: "drawer" },
    })
    expect(screen.getAllByRole("tab")).toHaveLength(3)
  })

  it("waits while recovering is true so switching threads does not spawn a duplicate shell", async () => {
    const recovered: TerminalSession = {
      id: "term_b",
      threadId: "th_2",
      projectId: "proj_1",
      cols: 80,
      rows: 24,
      shell: "zsh",
      cwd: "/repo/beta",
      cursor: 4,
      placement: "drawer",
      createdAt: "2026-11-25T10:00:00.000Z",
    }
    const { connection, calls } = await createTestConnection((method, params) => {
      if (method === "terminal.attach" && params.terminalId === "term_b") {
        return { session: recovered, replay: "ok\r\n", cursor: 4, truncated: false }
      }
      return undefined
    })

    const view = render(
      <LocaleProvider locale="zh-CN">
        <TerminalDrawer
          connection={connection}
          owner={{ threadId: "th_2" }}
          open
          recovering
          onClose={() => undefined}
        />
      </LocaleProvider>,
    )

    // 恢复查询未落定时绝不抢先调用 terminal.open。
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(calls.filter((call) => call.method === "terminal.open")).toHaveLength(0)

    view.rerender(
      <LocaleProvider locale="zh-CN">
        <TerminalDrawer
          connection={connection}
          owner={{ threadId: "th_2" }}
          open
          recovering={false}
          initialSessions={[recovered]}
          onClose={() => undefined}
        />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(calls.filter((call) => call.method === "terminal.attach")).toHaveLength(1)
    })
    expect(calls.filter((call) => call.method === "terminal.open")).toHaveLength(0)
    expect(screen.getAllByRole("tab")).toHaveLength(1)
    expect(screen.getByRole("tab", { name: "beta" })).toBeTruthy()
  })
})

describe("useTerminalRecovery hook (#85)", () => {
  it("recovers drawer (including legacy default placement) and workbench terminals into their respective panels without duplicates", async () => {
    const activeSessions: TerminalSession[] = [
      {
        id: "term_drawer_1",
        threadId: "th_1",
        projectId: "proj_1",
        cols: 80,
        rows: 24,
        shell: "zsh",
        cwd: "/repo/a",
        cursor: 10,
        placement: "drawer",
        createdAt: "2026-11-25T10:00:00.000Z",
      },
      {
        id: "term_legacy",
        threadId: "th_1",
        projectId: "proj_1",
        cols: 80,
        rows: 24,
        shell: "zsh",
        cwd: "/repo/a",
        cursor: 4,
        createdAt: "2026-11-25T10:01:00.000Z",
      },
      {
        id: "term_wb_1",
        threadId: "th_1",
        projectId: "proj_1",
        cols: 100,
        rows: 30,
        shell: "bash",
        cwd: "/repo/a",
        cursor: 20,
        placement: "workbench",
        createdAt: "2026-11-25T10:02:00.000Z",
      },
    ]

    const { connection } = await createTestConnection((method) => {
      if (method === "terminal.list") return activeSessions
      return undefined
    })

    const onOpenDrawer = vi.fn()
    const onOpenWorkbench = vi.fn()

    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) => {
        const [panels, setPanels] = useState<Record<string, PanelSurfaceState>>({})
        const recovery = useTerminalRecovery({
          connection,
          connected: true,
          connectionRevision: revision,
          slotKey: "th_1",
          scope: { threadId: "th_1" },
          panels,
          setPanels,
          onOpenDrawer,
          onOpenWorkbench,
          locale: "zh-CN",
        })
        return { panels, recovery }
      },
      { initialProps: { revision: 1 } },
    )

    await waitFor(() => {
      expect(result.current.recovery.drawerSessionsBySlot.th_1?.map((item) => item.id)).toEqual([
        "term_drawer_1",
        "term_legacy",
      ])
    })

    expect(result.current.recovery.recovering).toBe(false)
    expect(onOpenDrawer).toHaveBeenCalledWith("th_1", false)
    expect(onOpenWorkbench).toHaveBeenCalledWith("th_1", false)
    expect(result.current.panels.th_1?.surfaces).toEqual([
      expect.objectContaining({ kind: "terminal", terminalId: "term_wb_1" }),
    ])

    // 同一 slotKey 重连刷新列表时，已恢复过的终端不会重复加标签。
    rerender({ revision: 2 })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.recovery.drawerSessionsBySlot.th_1).toHaveLength(2)
    expect(result.current.panels.th_1?.surfaces).toHaveLength(1)
    expect(onOpenDrawer).toHaveBeenCalledTimes(1)
    expect(onOpenWorkbench).toHaveBeenCalledTimes(1)
  })

  it("degrades silently when an older Host does not support terminal.list", async () => {
    const { connection } = await createTestConnection((method) => {
      if (method === "terminal.list") throw new Error("unknown method: terminal.list")
      return undefined
    })

    const onOpenDrawer = vi.fn()
    const onOpenWorkbench = vi.fn()

    const { result } = renderHook(() => {
      const [panels, setPanels] = useState<Record<string, PanelSurfaceState>>({})
      const recovery = useTerminalRecovery({
        connection,
        connected: true,
        connectionRevision: 1,
        slotKey: "th_1",
        scope: { threadId: "th_1" },
        panels,
        setPanels,
        onOpenDrawer,
        onOpenWorkbench,
        locale: "zh-CN",
      })
      return { panels, recovery }
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.recovery.drawerSessionsBySlot).toEqual({})
    expect(result.current.panels).toEqual({})
    expect(onOpenDrawer).not.toHaveBeenCalled()
    expect(onOpenWorkbench).not.toHaveBeenCalled()
  })
})
