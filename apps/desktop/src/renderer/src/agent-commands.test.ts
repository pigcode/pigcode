// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react"
import type { Connection } from "@pigcode/client-runtime"
import type { AgentCommand } from "@pigcode/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetAgentCommandsCache, useAgentCommandsLoader } from "./agent-commands"

afterEach(() => {
  cleanup()
  resetAgentCommandsCache()
})
const matt: AgentCommand = { name: "ask-matt", text: "$ask-matt", kind: "skill" }
const connection = (call: ReturnType<typeof vi.fn>) => ({ call }) as unknown as Connection

describe("agent command loading", () => {
  it("refreshes a warm catalog once and shares pending refreshes", async () => {
    let resolve!: (commands: AgentCommand[]) => void
    const call = vi.fn().mockResolvedValueOnce([{ name: "old", text: "$old", kind: "skill" }])
    const connectionValue = connection(call)
    const { result } = renderHook(() =>
      useAgentCommandsLoader(connectionValue, { projectId: "p1" }),
    )
    await result.current("codex")
    await result.current("codex")
    expect(call).toHaveBeenCalledTimes(1)
    call.mockImplementationOnce(
      () =>
        new Promise<AgentCommand[]>((done) => {
          resolve = done
        }),
    )
    const fresh = result.current("codex", true)
    expect(result.current("codex", true)).toBe(fresh)
    expect(call).toHaveBeenLastCalledWith("agent.commands", {
      instanceId: "codex",
      projectId: "p1",
      refresh: true,
    })
    resolve([matt])
    await expect(fresh).resolves.toEqual([matt])
    await expect(result.current("codex")).resolves.toEqual([matt])
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("does not let a stale prefetch replace a refreshed catalog", async () => {
    let resolve!: (commands: AgentCommand[]) => void
    const call = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentCommand[]>((done) => {
            resolve = done
          }),
      )
      .mockResolvedValueOnce([matt])
    const connectionValue = connection(call)
    const { result } = renderHook(() => useAgentCommandsLoader(connectionValue, null))
    const prefetch = result.current("codex")
    await expect(result.current("codex", true)).resolves.toEqual([matt])
    resolve([])
    await prefetch
    await expect(result.current("codex")).resolves.toEqual([matt])
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("isolates connections, instances and projects, and retries empty or failed catalogs", async () => {
    const call = vi.fn().mockResolvedValue([matt])
    const first = connection(call)
    const secondCall = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([matt])
    const second = connection(secondCall)
    const { result, rerender } = renderHook(
      ({ conn, projectId }) => useAgentCommandsLoader(conn, { projectId }),
      {
        initialProps: { conn: first, projectId: "p1" },
      },
    )
    await result.current("codex")
    await result.current("claude")
    rerender({ conn: first, projectId: "p2" })
    await result.current("codex")
    expect(call).toHaveBeenCalledTimes(3)
    rerender({ conn: second, projectId: "p1" })
    await expect(result.current("codex")).resolves.toEqual([])
    await expect(result.current("codex")).resolves.toEqual([])
    await expect(result.current("codex")).resolves.toEqual([matt])
    expect(secondCall).toHaveBeenCalledTimes(3)
  })
})
