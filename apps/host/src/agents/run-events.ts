/** 把 Agent 的规范化事件映射为持久线程事件；delta 只走实时通道。 */
import type { AgentEvent, ThreadEvent } from "@pigcode/contracts"
import type { ActiveRun } from "./run-queue"

/** 事件映射所需的 Host 回调，避免 registry 与映射逻辑互相依赖。 */
export interface RunEventHooks {
  isActive: (run: ActiveRun) => boolean
  append: (
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ) => void
  updateNativeSessionId: (sessionId: string, nativeSessionId: string) => void
  finish: (
    run: ActiveRun,
    status: "completed" | "failed" | "interrupted",
    type: "run.completed" | "run.failed" | "run.interrupted",
    payload: unknown,
    error?: { code: string; message: string },
  ) => void
}

/** 只有存在父 tool_use id 时才写入 payload，保持其余事件形状不变。 */
function parentField(parentToolUseId: string | undefined): { parentToolUseId?: string } {
  return parentToolUseId === undefined ? {} : { parentToolUseId }
}

/** 映射一条 Agent 事件；run 已结束时丢弃迟到的消息。 */
export function mapAgentEvent(run: ActiveRun, event: AgentEvent, hooks: RunEventHooks): void {
  if (!hooks.isActive(run)) return
  switch (event.type) {
    case "run.started":
      return
    case "session.started":
      run.session.nativeSessionId = event.nativeSessionId
      hooks.updateNativeSessionId(run.session.id, event.nativeSessionId)
      hooks.append(run.threadId, run.runId, "session.started", {
        nativeSessionId: event.nativeSessionId,
      })
      return
    case "message.delta":
      // 子 agent 的流式增量不混入主时间线的 streamingText；其完整文本在
      // message.completed 中带 parentToolUseId 持久化。
      if (event.parentToolUseId === undefined) {
        run.liveText += event.text
        run.emitLive?.(event)
      }
      return
    case "message.completed":
      if (event.parentToolUseId === undefined) run.liveText = ""
      hooks.append(run.threadId, run.runId, "message.completed", {
        role: "assistant",
        text: event.text,
        ...parentField(event.parentToolUseId),
      })
      return
    case "reasoning.delta":
      if (event.parentToolUseId !== undefined) return
      run.reasoningStartedAt ??= Date.now()
      run.emitLive?.(event)
      return
    case "reasoning.completed": {
      if (event.text.trim().length === 0) return
      const startedAt = event.parentToolUseId === undefined ? run.reasoningStartedAt : undefined
      if (event.parentToolUseId === undefined) run.reasoningStartedAt = undefined
      hooks.append(run.threadId, run.runId, "reasoning.completed", {
        text: event.text,
        ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
        ...parentField(event.parentToolUseId),
      })
      return
    }
    case "tool.started":
      hooks.append(run.threadId, run.runId, "tool.started", {
        id: event.toolCallId,
        toolCallId: event.toolCallId,
        name: event.name,
        input: event.input,
        ...parentField(event.parentToolUseId),
      })
      return
    case "tool.completed":
      hooks.append(run.threadId, run.runId, "tool.completed", {
        id: event.toolCallId,
        toolCallId: event.toolCallId,
        name: event.name,
        output: event.output,
        isError: event.isError,
        status: event.isError ? "failed" : "completed",
        ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
        ...parentField(event.parentToolUseId),
      })
      return
    case "tool.outputDelta":
      run.emitLive?.(event)
      return
    case "subagent.started":
      hooks.append(run.threadId, run.runId, "subagent.started", {
        toolCallId: event.toolCallId,
        id: event.toolCallId,
        name: event.name,
        ...(event.description === undefined ? {} : { description: event.description }),
        ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...parentField(event.parentToolUseId),
      })
      return
    case "subagent.completed":
      hooks.append(run.threadId, run.runId, "subagent.completed", {
        toolCallId: event.toolCallId,
        id: event.toolCallId,
        ...(event.output === undefined ? {} : { output: event.output }),
        isError: event.isError,
        status: event.status,
      })
      return
    case "workflow.updated":
      hooks.append(run.threadId, run.runId, "workflow.updated", event.workflow)
      return
    case "usage.updated":
      hooks.append(run.threadId, run.runId, "usage.updated", { usage: event.usage })
      return
    case "context.updated":
      hooks.append(run.threadId, run.runId, "context.updated", {
        usedTokens: event.usedTokens,
        maxTokens: event.maxTokens,
        autoCompactTokens: event.autoCompactTokens,
      })
      return
    case "plan.updated":
      hooks.append(run.threadId, run.runId, "plan.updated", {
        plan: event.plan,
        explanation: event.explanation,
      })
      return
    case "notice":
      hooks.append(run.threadId, run.runId, "notice", {
        level: event.level,
        key: event.key,
        ...(event.params === undefined ? {} : { params: event.params }),
      })
      return
    case "run.interrupted":
      hooks.finish(run, "interrupted", "run.interrupted", {})
      return
    case "run.completed":
      hooks.finish(run, "completed", "run.completed", {})
      return
    case "run.failed":
      hooks.finish(
        run,
        "failed",
        "run.failed",
        { message: event.message },
        {
          code: "RUN_FAILED",
          message: event.message,
        },
      )
  }
}
