/** 真正启动排队 run：创建 Agent 会话、写 run.started 并执行 driver。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import type { RunStore } from "../storage/run-store"
import type { AgentSessionStore } from "./session-store"
import type { AgentSessionHandle, AgentSettingsValues, UserInput } from "./driver"
import type { ActiveRun, QueuedRun } from "./run-queue"
import { handoffForRun } from "./handoff-delivery"
import { freshSessionHandoff } from "./switching"

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
    const resuming = Boolean(entry.nativeSessionId ?? entry.forkFromNativeSessionId)
    let session: AgentSessionHandle
    let lost = false
    try {
      session = await openSession(entry, deps, true)
    } catch (error) {
      // Codex 在 createSession 里 thread/resume；原生 thread 不在了就改开新的，而不是每次都失败。
      if (!resuming || !entry.driver.isSessionNotFound?.(messageOf(error))) throw error
      session = await startFresh(entry, deps, entry.sessionId)
      lost = true
    }
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
      resuming: resuming && !lost,
      startFresh: () => startFresh(entry, deps, run.session.id),
    }
    // 带上还没发出的交接（切换 Agent、子代理说明）；原生会话接不上时，新会话还要带上这一轮之前的对话。
    const fresh = lost
      ? freshSessionHandoff(deps.ctx, run.threadId, run.runId, entry.input.text, entry.instanceId)
      : null
    const handoff = handoffForRun(
      deps.ctx.storage.db,
      run.threadId,
      run.runId,
      entry.input.text,
      fresh,
    )
    deps.runs.setStatus(run.runId, "running")
    deps.append(run.threadId, run.runId, "run.started", {
      agentId: run.driver.id,
      instanceId: entry.instanceId,
      agentSessionId: run.session.id,
    })
    deps.activeRuns.set(run.runId, run)
    void deps.execute(run, handoff === null ? entry.input : { ...entry.input, handoff })
  } catch (error) {
    const message = messageOf(error)
    deps.runs.setStatus(entry.runId, "failed", { code: "AGENT_ERROR", message })
    deps.append(entry.threadId, entry.runId, "run.failed", { message })
    deps.activeThreads.delete(entry.threadId)
    entry.resolveDone()
  }
}

/** 让 driver 建会话并写会话行；resume 为 false 时不接续任何原生会话、也不复用旧行。 */
async function openSession(
  entry: QueuedRun,
  deps: LaunchDeps,
  resume: boolean,
): Promise<AgentSessionHandle> {
  const fork = resume ? entry.forkFromNativeSessionId : undefined
  const draft = await entry.driver.createSession({
    threadId: entry.threadId,
    cwd: entry.cwd,
    nativeSessionId: fork || !resume ? null : entry.nativeSessionId,
    ...(fork ? { forkFromNativeSessionId: fork } : {}),
    permissionMode: entry.permissionMode,
    model: entry.model,
    ...(resume && entry.sessionId ? { sessionId: entry.sessionId } : {}),
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
  return session
}

/**
 * 要接续的原生会话已经不存在：停掉旧的会话行，开一个新的原生会话，并在时间线上说明。
 * 旧行必须先停掉，否则 reuseOrCreate 会又把它找回来。
 */
async function startFresh(
  entry: QueuedRun,
  deps: LaunchDeps,
  lostSessionId: string | undefined,
): Promise<AgentSessionHandle> {
  const now = new Date().toISOString()
  if (lostSessionId) deps.agentSessions.stop(lostSessionId, now)
  const session = await openSession(entry, deps, false)
  deps.append(entry.threadId, entry.runId, "notice", {
    level: "warning",
    key: "session.resumeFailed",
  })
  return session
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
