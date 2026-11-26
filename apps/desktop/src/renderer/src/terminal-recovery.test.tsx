// @vitest-environment jsdom
/** 验证窗口端终端重新附着、游标去重、草稿改绑与页面内重连恢复（#85）。 */
import { StrictMode } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { MemoryTransport } from "../../../../host/src/rpc/memory-transport"

vi.mock("@pigcode/ui-workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pigcode/ui-workbench")>()
  const React = await import("react")
  const { createFakeTerminalView } = await import("./terminal-recovery.fixtures")
  return { ...actual, TerminalView: createFakeTerminalView(React) }
})

import { TerminalSurface, type TerminalSession } from "./terminal-surface"
import {
  createTestConnection,
  resetWrittenByMount,
  writtenByMount,
  type RpcCallRecord,
} from "./terminal-recovery.fixtures"

afterEach(() => {
  cleanup()
  resetWrittenByMount()
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
    const onClosed = vi.fn()
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
            onClosed={onClosed}
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
    expect(onClosed).not.toHaveBeenCalled()
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
    expect(onClosed).toHaveBeenCalledWith("term_existing")
    expect(
      calls.some(
        (call) => call.method === "terminal.close" && call.params.terminalId === "term_existing",
      ),
    ).toBe(true)
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
    const {
      connection,
      transport: firstTransport,
      calls,
    } = await createTestConnection((method) => {
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
      const req = raw as {
        id?: string | number
        method?: string
        params?: Record<string, unknown>
      }
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
