// @vitest-environment jsdom
/** 验证 Host 重启后即使没有打开任何会话标签（0 订阅同步重连），侧栏也能刷新为 interrupted（#84）。 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Project, Thread } from "@pigcode/contracts"
import { AppStore, Connection } from "@pigcode/client-runtime"
import { MemoryTransport } from "../../../../host/src/rpc/memory-transport"
import { mergeChildStatus } from "./thread-status"
import { useWorkspaceSync } from "./workspace-sync"

const now = "2026-11-25T10:00:00.000Z"
const sampleProject: Project = {
  id: "p1",
  rootPath: "/tmp/p1",
  name: "p1",
  createdAt: now,
}

function sampleThread(id: string, status: Thread["status"]): Thread {
  return {
    id,
    projectId: "p1",
    title: id,
    defaultAgentId: "fake",
    defaultInstanceId: null,
    lastAgentId: null,
    lastInstanceId: null,
    lastModelId: null,
    permissionMode: "auto-accept-edits",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    lastRunId: "run_1",
    status,
  }
}

function serveWorkspace(transport: MemoryTransport, threads: Thread[]): void {
  transport.host.onMessage((raw) => {
    const req = raw as { id?: string | number; method?: string }
    if (req.id === undefined) return
    if (req.method === "project.list") {
      transport.host.send({ jsonrpc: "2.0", id: req.id, result: [sampleProject] })
    } else if (req.method === "thread.list") {
      transport.host.send({ jsonrpc: "2.0", id: req.id, result: threads })
    }
  })
}

describe("useWorkspaceSync (#84)", () => {
  it("reconciles running and waiting-approval threads to interrupted after a 0-subscription Host restart", async () => {
    const store = new AppStore()
    const connection = new Connection({
      onEvent: (event) => store.addEvent(event),
      onEvents: (events, threadId) => store.addEvents(events, threadId),
      onDelta: () => undefined,
      onStatus: (status) =>
        store.update(
          status === "connected"
            ? { status, connectionRevision: connection.connectionRevision }
            : { status },
        ),
      onThreadChanged: (thread) => store.upsertThread(thread),
      onProjectsChanged: (projects) => store.update({ projects }),
    })
    const onError = vi.fn()

    const firstHost = new MemoryTransport()
    serveWorkspace(firstHost, [
      sampleThread("t-running", "running"),
      sampleThread("t-approval", "waiting-approval"),
    ])

    const hook = renderHook(() => useWorkspaceSync(connection, store, onError))

    await act(async () => {
      await connection.attach(firstHost.client)
    })

    await waitFor(() => {
      const state = store.getSnapshot()
      expect(mergeChildStatus(state.threads, state.threadStates)).toEqual({
        "t-running": "running",
        "t-approval": "waiting-approval",
      })
    })

    // Host 进程重启并执行 recoverAfterRestart()，此时窗口未打开任何会话标签（0 订阅同步重连）。
    const restartedHost = new MemoryTransport()
    serveWorkspace(restartedHost, [
      sampleThread("t-running", "interrupted"),
      sampleThread("t-approval", "interrupted"),
    ])

    await act(async () => {
      await connection.attach(restartedHost.client)
    })

    await waitFor(() => {
      const state = store.getSnapshot()
      expect(mergeChildStatus(state.threads, state.threadStates)).toEqual({
        "t-running": "interrupted",
        "t-approval": "interrupted",
      })
    })

    expect(onError).not.toHaveBeenCalled()
    hook.unmount()
  })
})
