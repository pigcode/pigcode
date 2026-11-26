/** 运行取消、中断、按实例/设备停止以及注销 driver 时的清理。 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { Context } from "cordis"
import type { RunStore } from "../storage/run-store"
import type { AgentDriver } from "./driver"
import type { createRunFinisher } from "./run-finish"
import type { ActiveRun, QueuedRun, RunQueue } from "./run-queue"

interface CancellationCatalog {
  instances(agentId: string): ReadonlyArray<{ instanceId: string }>
  invalidate(id: string): void
}

export interface RunCancellationDeps {
  ctx: Context
  drivers: Map<string, AgentDriver>
  agents: CancellationCatalog
  runs: RunStore
  queue: RunQueue<QueuedRun>
  starting: Map<string, QueuedRun>
  activeRuns: Map<string, ActiveRun>
  activeThreads: Set<string>
  append(threadId: string, runId: string | null, type: ThreadEvent["type"], payload: unknown): void
  finishRun: ReturnType<typeof createRunFinisher>
}

export function createRunCancellation(deps: RunCancellationDeps) {
  const {
    ctx,
    drivers,
    agents,
    runs,
    queue,
    starting,
    activeRuns,
    activeThreads,
    append,
    finishRun,
  } = deps

  function persistUnstartedStop(entry: QueuedRun, recordReceipt?: () => void): () => void {
    return ctx.sessions.stageEvents(() => {
      recordReceipt?.()
      if (runs.get(entry.runId)?.status === "interrupted") return
      runs.setStatus(entry.runId, "interrupted")
      append(entry.threadId, entry.runId, "run.interrupted", {})
    })
  }

  /** 取消排队中的 run；此时尚未创建 Agent 会话，只需写终态并释放线程。 */
  function cancelQueuedRun(runId: string, recordReceipt?: () => void): boolean {
    const entry = queue.values().find((item) => item.runId === runId)
    if (!entry) return false
    const publish = persistUnstartedStop(entry, recordReceipt)
    queue.remove((item) => item.runId === runId)
    activeThreads.delete(entry.threadId)
    publish()
    entry.resolveDone()
    return true
  }

  /** 中断单个活跃或排队中的 run；未知 run 返回 false。 */
  function interruptRun(runId: string, recordReceipt?: () => void): boolean {
    if (cancelQueuedRun(runId, recordReceipt)) return true
    const launching = starting.get(runId)
    if (launching && !activeRuns.has(runId)) {
      const publish = persistUnstartedStop(launching, recordReceipt)
      launching.controller.abort()
      publish()
      return true
    }
    const run = activeRuns.get(runId)
    if (!run) return false
    finishRun(run, "interrupted", "run.interrupted", {}, undefined, recordReceipt)
    return true
  }

  function interruptAll(): void {
    for (const entry of [...queue.values()]) cancelQueuedRun(entry.runId)
    for (const runId of starting.keys()) interruptRun(runId)
    for (const runId of [...activeRuns.keys()]) interruptRun(runId)
  }

  async function stopInstanceRuns(instanceId: string): Promise<void> {
    for (const entry of queue.values()) {
      if (entry.instanceId === instanceId) cancelQueuedRun(entry.runId)
    }
    const pending = [...starting.values()].filter((entry) => entry.instanceId === instanceId)
    for (const entry of pending) interruptRun(entry.runId)
    for (const run of [...activeRuns.values()]) {
      if (run.instanceId === instanceId) interruptRun(run.runId)
    }
    await Promise.all(pending.map((entry) => entry.done))
  }

  function cancelDeviceQueuedRuns(deviceKey: string): void {
    for (const entry of [...queue.values(), ...starting.values()]) {
      if (activeRuns.has(entry.runId)) continue
      if (entry.sourceDevice !== deviceKey && entry.isAuthorized?.() !== false) continue
      entry.controller.abort()
      try {
        interruptRun(entry.runId)
      } catch (error) {
        console.error("[host] could not record revoked run interruption", error)
      }
    }
  }

  /** 注销 driver 时取消排队任务，中断活跃任务并释放会话进程。 */
  function unregisterDriver(driverId: string): void {
    const driver = drivers.get(driverId)
    if (!driver) return
    for (const entry of queue.values()) {
      if (entry.driver === driver) cancelQueuedRun(entry.runId)
    }
    for (const entry of starting.values()) {
      if (entry.driver === driver) interruptRun(entry.runId)
    }
    for (const run of [...activeRuns.values()]) {
      if (run.driver !== driver) continue
      interruptRun(run.runId)
      void driver.dispose(run.session).catch(() => undefined)
    }
    drivers.delete(driverId)
    // 这个 agent 的所有实例的检测与模型目录都重新读取。
    for (const instance of agents.instances(driverId)) agents.invalidate(instance.instanceId)
    agents.invalidate(driverId)
  }

  return {
    interruptRun,
    interruptAll,
    stopInstanceRuns,
    cancelDeviceQueuedRuns,
    unregisterDriver,
  }
}
