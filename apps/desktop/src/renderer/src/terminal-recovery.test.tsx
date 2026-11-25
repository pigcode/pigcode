// @vitest-environment jsdom
/** 验证窗口端终端重新附着、游标去重、草稿改绑、多标签恢复与 drawer/workbench 自动还原（#85）。 */
import { StrictMode, useState } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Connection } from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import type { PanelSurfaceState, TerminalViewProps } from "@pigcode/ui-workbench"
import { MemoryTransport } from "../../../../host/src/rpc/memory-transport"

const writtenByMount: string[][] = []

vi.mock("@pigcode/ui-workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pigcode/ui-workbench")>()
  const React = await import("react")
  function FakeTerminalView({ onResize, onReady }: TerminalViewProps) {
    const onResizeRef = React.useRef(onResize)
    const onReadyRef = React.useRef(onReady)
    onResizeRef.current = onResize
    onReadyRef.current = onReady
    React.useEffect(() => {
      const writes: string[] = []
      writtenByMount.push(writes)
      onReadyRef.current?.({
        write: (data: string) => writes.push(data),
        fit: () => undefined,
        focus: () => undefined,
      })
      onResizeRef.current?.(96, 28)
      return () => {
        onReadyRef.current?.(null)
      }
    }, [])
    return React.createElement("div", { "data-testid": "terminal-view" })
  }
  return { ...actual, TerminalView: FakeTerminalView }
})

import { TerminalDrawer } from "./terminal-drawer"
import { TerminalSurface, type TerminalSession } from "./terminal-surface"
import { useTerminalRecovery } from "./use-terminal-recovery"

interface RpcCallRecord {
  method: string
  params: Record<string, unknown>
}

async function createTestConnection(
  handler: (method: string, params: Record<string, unknown>, id: string | number) => unknown,
) {
  const transport = new MemoryTransport()
  const calls: RpcCallRecord[] = []
  transport.host.onMessage((raw) => {
    const req = raw as { id?: string | number; method?: string; params?: Record<string, unknown> }
    if (req.id === undefined || !req.method) return
    const params = req.params ?? {}
    calls.push({ method: req.method, params })
    try {
      const result = handler(req.method, params, req.id)
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).then(
          (resolved) =>
            transport.host.send({ jsonrpc: "2.0", id: req.id, result: resolved }),
          (error: unknown) =>
            transport.host.send({
              jsonrpc: "2.0",
              id: req.id,
              error: {
                code: "COMMAND_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        )
      } else {
        transport.host.send({ jsonrpc: "2.0", id: req.id, result })
      }
    } catch (error) {
      transport.host.send({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: "COMMAND_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })

  const connection = new Connection({
    onEvent: () => undefined,
    onDelta: () => undefined,
    onStatus: () => undefined,
  })
  await connection.attach(transport.client)
  return { connection, transport, calls }
}

afterEach(() => {
  cleanup()
  writtenByMount.length = 0
})

describe("TerminalSurface reattach and rebind (#85)", () => {
  it("reattaches to an existing terminal, replays scrollback, deduplicates by cursor, and skips terminal.open", async () => {
    const existing: TerminalSession = {
      id: "term_existing",
      threadId: "th_1",
      projectId: "proj_1",
      cols: 80,
      rows: 24,
      shell: "zsh",
      cwd: "/repo/demo",
      cursor: 12,
      placement: "drawer",
      createdAt: "2026-11-25T10:00:00.000Z",
    }
    const { connection, transport, calls } = await createTestConnection((method) => {
      if (method === "terminal.attach") {
        return {
          session: existing,
          replay: "saved-line\r\n",
          cursor: 12,
          truncated: false,
        }
      }
      return undefined
    })

    const onOpened = vi.fn()
    const view = render(
      <StrictMode>
        <LocaleProvider locale="zh-CN">
          <TerminalSurface
            connection={connection}
            owner={{ threadId: "th_1" }}
            active
            placement="drawer"
            attachTerminalId="term_existing"
            onOpened={onOpened}
          />
        </LocaleProvider>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(onOpened).toHaveBeenCalledWith(existing)
    })

    // StrictMode 下第一次卸载绝不误杀已有终端，且绝不调用 terminal.open。
    expect(calls.some((call) => call.method === "terminal.open")).toBe(false)
    expect(calls.some((call) => call.method === "terminal.close")).toBe(false)
    expect(calls.filter((call) => call.method === "terminal.attach")).toContainEqual({
      method: "terminal.attach",
      params: { terminalId: "term_existing", cols: 96, rows: 28 },
    })

    // 推送一条旧游标（<= 12）的重复帧与一条新游标（18）的实时帧。
    act(() => {
      transport.host.send({
        jsonrpc: "2.0",
        method: "terminal.output",
        params: { terminalId: "term_existing", data: "duplicate", cursor: 12 },
      })
      transport.host.send({
        jsonrpc: "2.0",
        method: "terminal.output",
        params: { terminalId: "term_existing", data: "live!\n", cursor: 18 },
      })
    })

    const writes = writtenByMount.at(-1) ?? []
    expect(writes).toEqual(["saved-line\r\n", "live!\n"])

    view.unmount()
    expect(calls.some((call) => call.method === "terminal.close" && call.params.terminalId === "term_existing")).toBe(true)
  })

  it("calls onExit instead of showing an error when attaching to an already-exited terminal", async () => {
    const { connection, calls } = await createTestConnection((method) => {
      if (method === "terminal.attach") {
        throw new Error("terminal not found: term_gone")
      }
      return undefined
    })
    const onExit = vi.fn()

    render(
      <LocaleProvider locale="zh-CN">
        <TerminalSurface
          connection={connection}
          owner={{ threadId: "th_1" }}
          active
          attachTerminalId="term_gone"
          onExit={onExit}
        />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(onExit).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByText(/terminal not found/i)).toBeNull()
    expect(calls.some((call) => call.method === "terminal.close")).toBe(false)
  })

  it("rebinds a draft terminal when owner transitions from projectId to threadId", async () => {
    const { connection, calls } = await createTestConnection((method) => {
      if (method === "terminal.open") {
        return {
          id: "term_draft",
          threadId: null,
          projectId: "proj_1",
          cols: 96,
          rows: 28,
          shell: "zsh",
          cwd: "/repo/demo",
          cursor: 0,
          placement: "drawer",
          createdAt: "2026-11-25T10:00:00.000Z",
        }
      }
      if (method === "terminal.rebind") {
        return {
          id: "term_draft",
          threadId: "th_new",
          projectId: "proj_1",
          cols: 96,
          rows: 28,
          shell: "zsh",
          cwd: "/repo/demo",
          cursor: 0,
          placement: "drawer",
          createdAt: "2026-11-25T10:00:00.000Z",
        }
      }
      return undefined
    })

    const onOpened = vi.fn()
    const view = render(
      <LocaleProvider locale="zh-CN">
        <TerminalSurface
          connection={connection}
          owner={{ projectId: "proj_1" }}
          active
          placement="drawer"
          onOpened={onOpened}
        />
      </LocaleProvider>,
    )

    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1))
    expect(calls).toContainEqual({
      method: "terminal.open",
      params: { projectId: "proj_1", cols: 96, rows: 28, placement: "drawer" },
    })

    view.rerender(
      <LocaleProvider locale="zh-CN">
        <TerminalSurface
          connection={connection}
          owner={{ threadId: "th_new" }}
          active
          placement="drawer"
          onOpened={onOpened}
        />
      </LocaleProvider>,
    )

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "terminal.rebind",
        params: { terminalId: "term_draft", threadId: "th_new" },
      })
    })
  })

  it("reattaches from the latest cursor on in-page reconnect and closes cleanly if Host restarted", async () => {
    const { connection, transport: firstTransport, calls } = await createTestConnection((method) => {
      if (method === "terminal.open") {
        return {
          id: "term_live",
          threadId: "th_1",
          projectId: "proj_1",
          cols: 96,
          rows: 28,
          shell: "zsh",
          cwd: "/repo/demo",
          cursor: 0,
          placement: "drawer",
          createdAt: "2026-11-25T10:00:00.000Z",
        }
      }
      return undefined
    })

    const onOpened = vi.fn()
    const onExit = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <TerminalSurface
          connection={connection}
          owner={{ threadId: "th_1" }}
          active
          placement="drawer"
          onOpened={onOpened}
          onExit={onExit}
        />
      </LocaleProvider>,
    )

    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1))

    act(() => {
      firstTransport.host.send({
        jsonrpc: "2.0",
        method: "terminal.output",
        params: { terminalId: "term_live", data: "before\n", cursor: 7 },
      })
    })
    expect(writtenByMount.at(-1)).toEqual(["before\n"])

    // 模拟页面未刷新但传输层重连到仍在运行的 Host：自动携带 afterCursor: 7 重新 attach。
    const secondTransport = new MemoryTransport()
    const secondCalls: RpcCallRecord[] = []
    secondTransport.host.onMessage((raw) => {
      const req = raw as { id?: string | number; method?: string; params?: Record<string, unknown> }
      if (req.id === undefined || !req.method) return
      const params = req.params ?? {}
      secondCalls.push({ method: req.method, params })
      if (req.method === "terminal.attach") {
        secondTransport.host.send({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            session: {
              id: "term_live",
              threadId: "th_1",
              projectId: "proj_1",
              cols: 96,
              rows: 28,
              shell: "zsh",
              cwd: "/repo/demo",
              cursor: 14,
            },
            replay: "missed\n",
            cursor: 14,
            truncated: false,
          },
        })
      }
    })
    await act(async () => {
      await connection.attach(secondTransport.client)
    })

    await waitFor(() => {
      expect(secondCalls).toContainEqual({
        method: "terminal.attach",
        params: { terminalId: "term_live", afterCursor: 7, cols: 96, rows: 28 },
      })
    })
    act(() => {
      secondTransport.host.send({
        jsonrpc: "2.0",
        method: "terminal.output",
        params: { terminalId: "term_live", data: "resumed\n", cursor: 22 },
      })
    })
    expect(writtenByMount.at(-1)).toEqual(["before\n", "missed\n", "resumed\n"])
    expect(onExit).not.toHaveBeenCalled()

    // 模拟 Host 重启后重连：旧 PTY 不再存在，attach 返回 terminal not found，平滑触发 onExit。
    const thirdTransport = new MemoryTransport()
    thirdTransport.host.onMessage((raw) => {
      const req = raw as { id?: string | number; method?: string }
      if (req.id === undefined || !req.method) return
      if (req.method === "terminal.attach") {
        thirdTransport.host.send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: "COMMAND_FAILED", message: "terminal not found: term_live" },
        })
      }
    })
    await act(async () => {
      await connection.attach(thirdTransport.client)
    })
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1))
    expect(calls.some((call) => call.method === "terminal.close")).toBe(false)
  })
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
        return { session, replay: `replay:${session.id}`, cursor: session.cursor ?? 0, truncated: false }
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
