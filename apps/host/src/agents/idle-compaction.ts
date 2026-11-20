import type { Context } from "cordis"

interface IdleTurn {
  runId: string
  activeWork: Set<string>
  instanceId?: string
  sessionId?: string
  expiresAt?: number
  timer?: ReturnType<typeof setTimeout>
}

/** 只调度已有 Claude 会话的显式 /compact 运行；重启后不补发已过期的维护请求。 */
export function watchClaudeIdleCompaction(ctx: Context, hasCapacity: () => boolean): () => void {
  const candidates = new Map<string, IdleTurn>()
  function forget(threadId: string) {
    clearTimeout(candidates.get(threadId)?.timer)
    candidates.delete(threadId)
  }
  function selected(threadId: string, instanceId: string) {
    const thread = ctx.threads.get(threadId)
    if (
      !thread ||
      thread.archivedAt ||
      thread.parentThreadId ||
      (thread.lastAgentId ?? thread.defaultAgentId) !== "claude" ||
      (thread.lastInstanceId ?? thread.defaultInstanceId ?? "claude") !== instanceId
    )
      return false
    const instance = ctx.agents.findInstance(instanceId)
    if (!instance?.enabled || !ctx.agents.list().some((agent) => agent.id === "claude"))
      return false
    const override = instance.values.idleCompaction
    return (
      (override === undefined || override === "default"
        ? ctx.get("settings")?.get("claude.idleCompaction")
        : override) === "beforeCacheExpires"
    )
  }

  const unsubscribe = ctx.sessions.subscribeAll((event) => {
    const { threadId, runId, type } = event
    const data = (event.payload ?? {}) as Record<string, unknown>
    if (type === "thread.updated" && (data.agentId !== undefined || data.handoffId !== undefined)) {
      forget(threadId)
      return
    }
    if (type === "message.completed" && data.role === "user") {
      forget(threadId)
      if (runId && typeof data.text === "string" && !/^\/compact(?:\s|$)/i.test(data.text.trim())) {
        const thread = ctx.threads.get(threadId)
        if (thread && (thread.lastAgentId ?? thread.defaultAgentId) === "claude")
          candidates.set(threadId, { runId, activeWork: new Set() })
      }
      return
    }
    const turn = candidates.get(threadId)
    if (!turn || turn.runId !== runId) return
    if (
      type === "run.started" &&
      data.agentId === "claude" &&
      typeof data.instanceId === "string" &&
      typeof data.agentSessionId === "string"
    ) {
      turn.instanceId = data.instanceId
      turn.sessionId = data.agentSessionId
    } else if (
      (type === "subagent.started" || type === "tool.started") &&
      typeof data.toolCallId === "string"
    ) {
      turn.activeWork.add(type.split(".")[0] + ":" + data.toolCallId)
    } else if (
      (type === "subagent.completed" || type === "tool.completed") &&
      typeof data.toolCallId === "string"
    ) {
      turn.activeWork.delete(type.split(".")[0] + ":" + data.toolCallId)
    } else if (type === "workflow.updated" && typeof data.toolCallId === "string") {
      const key = "workflow:" + data.toolCallId
      if (data.status === "running") turn.activeWork.add(key)
      else turn.activeWork.delete(key)
    } else if (type === "context.updated") {
      delete turn.expiresAt
      if (
        typeof data.usedTokens === "number" &&
        data.usedTokens >= 200_000 &&
        typeof data.promptCacheExpiresAt === "string"
      ) {
        const end = Date.parse(data.promptCacheExpiresAt)
        if (Number.isFinite(end)) turn.expiresAt = end
      }
    } else if (type === "run.failed" || type === "run.interrupted") forget(threadId)
    else if (type === "run.completed") {
      const { instanceId, expiresAt, sessionId } = turn
      if (
        turn.activeWork.size > 0 ||
        !instanceId ||
        !sessionId ||
        !expiresAt ||
        expiresAt <= Date.now() ||
        !selected(threadId, instanceId)
      ) {
        forget(threadId)
        return
      }
      clearTimeout(turn.timer)
      turn.timer = setTimeout(
        () => {
          if (candidates.get(threadId) !== turn) return
          forget(threadId)
          if (
            Date.now() >= expiresAt ||
            !hasCapacity() ||
            !selected(threadId, instanceId) ||
            ctx.agents.listRuns().some((run) => run.threadId === threadId) ||
            ctx.agents.listPendingRequests(threadId).length
          )
            return
          const session = ctx.agents.listSessions(threadId).find((row) => row.id === sessionId)
          if (session?.status !== "active" || !session.nativeSessionId) return
          void ctx.agents
            .startRun(threadId, "/compact", undefined, { instanceId })
            .catch(() => undefined)
        },
        Math.max(0, expiresAt - Date.now() - 120_000),
      )
      turn.timer.unref()
    }
  })
  return () => {
    unsubscribe()
    for (const turn of candidates.values()) clearTimeout(turn.timer)
    candidates.clear()
  }
}
