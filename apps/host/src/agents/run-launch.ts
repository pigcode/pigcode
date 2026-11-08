/** 真正启动排队 run：创建 Agent 会话、写 run.started 并执行 driver。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import type { RunStore } from "../storage/run-store"
import type { AgentSessionStore } from "./session-store"
import type { AgentSettingsValues, UserInput } from "./driver"
import type { ActiveRun, QueuedRun } from "./run-queue"
import { pendingHandoff } from "./switching"

/** launchRun 需要的最小 Host 依赖；由 registry 组装，避免 registry 超过 500 行。 */
export interface LaunchDeps {
  ctx: Context
  agentSessions: AgentSessionStore
  runs: RunStore
  activeRuns: Map<string, ActiveRun>
  activeThreads: Set<string>
  append: (
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ) => void
  execute: (run: ActiveRun, input: UserInput) => void
  /** 启动时读取实例的最新设置；排队期间改的设置同样生效。 */
  settingsFor: (agentId: string, instanceId: string) => AgentSettingsValues
}

/** 启动排队 run：此时才创建 Agent 会话，避免为未开始的 run 提前启动子进程。 */
export async function launchRun(entry: QueuedRun, deps: LaunchDeps): Promise<void> {
  try {
    const draft = await entry.driver.createSession({
      threadId: entry.threadId,
      cwd: entry.cwd,
      nativeSessionId: entry.forkFromNativeSessionId ? null : entry.nativeSessionId,
      ...(entry.forkFromNativeSessionId
        ? { forkFromNativeSessionId: entry.forkFromNativeSessionId }
        : {}),
      permissionMode: entry.permissionMode,
      model: entry.model,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.mcp ? { mcp: entry.mcp } : {}),
      settings: deps.settingsFor(entry.driver.id, entry.instanceId),
    })
    const session = deps.agentSessions.reuseOrCreate({
      draft,
      agentId: entry.driver.id,
      instanceId: entry.instanceId,
      createdAt: entry.queuedAt,
    })
    deps.runs.setAgentSessionId(entry.runId, session.id)
    const run: ActiveRun = {
      runId: entry.runId,
      threadId: entry.threadId,
      session,
      driver: entry.driver,
      controller: entry.controller,
      emitLive: entry.emitLive,
      status: "running",
      done: entry.done,
      resolveDone: entry.resolveDone,
      approvals: new Set(),
      liveText: "",
    }
    // 切换 Agent 后的第一条消息注入一次 handoff；事件读取要在 run.started 之前。
    const handoff = pendingHandoff(deps.ctx, run.threadId)
    deps.runs.setStatus(run.runId, "running")
    deps.append(run.threadId, run.runId, "run.started", {
      agentId: run.driver.id,
      instanceId: entry.instanceId,
      agentSessionId: run.session.id,
    })
    deps.activeRuns.set(run.runId, run)
    void deps.execute(run, handoff === null ? entry.input : { ...entry.input, handoff })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.runs.setStatus(entry.runId, "failed", { code: "AGENT_ERROR", message })
    deps.append(entry.threadId, entry.runId, "run.failed", { message })
    deps.activeThreads.delete(entry.threadId)
    entry.resolveDone()
  }
}
