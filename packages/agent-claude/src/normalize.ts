/** 把 Claude Agent SDK 消息映射为 Pigcode 规范化事件。 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent } from "@pigcode/contracts"
import {
  WORKFLOW_TOOL,
  createTaskState,
  hasPendingTasks,
  isWorkflowCall,
  taskEvents,
  workflowRejected,
  workflowStarted,
  type TaskState,
} from "./workflow"

/** 子 agent 的展示信息；由 Task/Agent tool_use 创建，tool_result 时移除。 */
interface SubagentInfo {
  name: string
  description?: string
  model?: string
}

/** 单次 run 内的归一化状态；记录已流式文本、工具名与活跃子 agent。 */
export interface NormalizeState {
  streamedText: string
  /** 主 agent 最后落成的一段文字；result 重复它时不再写第二遍。 */
  lastText: string
  toolNames: Map<string, string>
  subagents: Map<string, SubagentInfo>
  /** 后台任务与工作流。 */
  tasks: TaskState
}

/** 创建一次 run 专属的归一化状态。 */
export function createNormalizeState(): NormalizeState {
  return {
    streamedText: "",
    lastText: "",
    toolNames: new Map(),
    subagents: new Map(),
    tasks: createTaskState(),
  }
}

/** 只有非空 parent_tool_use_id 才需要写入事件 payload。 */
function parentFields(parentToolUseId: string | null): { parentToolUseId?: string } {
  return parentToolUseId ? { parentToolUseId } : {}
}

/** 把 unknown 收窄为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 只接受非空字符串。 */
function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** 一条 SDK 消息可能产生零到多个事件。 */
export function normalizeSdkMessage(message: SDKMessage, state: NormalizeState): AgentEvent[] {
  const events: AgentEvent[] = []
  if (message.type === "system" && message.subtype === "init") {
    events.push({ type: "session.started", nativeSessionId: message.session_id })
    return events
  }
  const tasks = taskEvents(state.tasks, message)
  if (tasks) return tasks
  if (message.type === "stream_event") {
    const parentToolUseId = message.parent_tool_use_id ?? null
    const event = message.event
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      state.streamedText += event.delta.text
      events.push({
        type: "message.delta",
        text: event.delta.text,
        ...parentFields(parentToolUseId),
      })
    } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
      events.push({
        type: "reasoning.delta",
        text: event.delta.thinking,
        ...parentFields(parentToolUseId),
      })
    }
    return events
  }
  if (message.type === "assistant") {
    const parentToolUseId = message.parent_tool_use_id ?? null
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        state.toolNames.set(block.id, block.name)
        if (block.name === "Task" || block.name === "Agent") {
          events.push(subagentStarted(block.id, block.name, block.input, parentToolUseId, state))
          continue
        }
        // 工作流画成一张单独的卡片，不再当普通工具行。
        if (block.name === WORKFLOW_TOOL) {
          events.push(workflowStarted(state.tasks, block.id, block.input, parentToolUseId))
          continue
        }
        events.push({
          type: "tool.started",
          toolCallId: block.id,
          name: block.name,
          input: block.input,
          ...parentFields(parentToolUseId),
        })
      } else if (block.type === "thinking") {
        if (block.thinking.trim().length > 0) {
          events.push({
            type: "reasoning.completed",
            text: block.thinking,
            ...parentFields(parentToolUseId),
          })
        }
      } else if (block.type === "text" && block.text.trim().length > 0) {
        // 工具之间的说明也要落成消息，否则结束后时间线里只剩最后一段回答；
        // 子 agent 的文本带 parent 归入对应卡片，不冒充主助手消息。
        if (!parentToolUseId) state.lastText = block.text
        events.push({
          type: "message.completed",
          text: block.text,
          ...parentFields(parentToolUseId),
        })
      }
    }
    return events
  }
  if (message.type === "user") {
    const parentToolUseId = message.parent_tool_use_id ?? null
    const content = message.message.content
    if (!Array.isArray(content)) return events
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const toolCallId = block.tool_use_id
      if (isWorkflowCall(state.tasks, toolCallId)) {
        // 工具立刻返回「已在后台启动」，进度与结果走后台任务消息；只有报错时工作流直接失败。
        state.toolNames.delete(toolCallId)
        if (block.is_error !== true) continue
        const rejected = workflowRejected(state.tasks, toolCallId, toolResultText(block.content))
        if (rejected) events.push(rejected)
        continue
      }
      const subagent = state.subagents.get(toolCallId)
      if (subagent) {
        const isError = block.is_error === true
        events.push({
          type: "subagent.completed",
          toolCallId,
          ...(block.content === undefined ? {} : { output: block.content }),
          isError,
          status: isError ? "failed" : "completed",
        })
        state.subagents.delete(toolCallId)
        state.toolNames.delete(toolCallId)
        continue
      }
      events.push({
        type: "tool.completed",
        toolCallId,
        name: state.toolNames.get(toolCallId) ?? "tool",
        output: block.content,
        isError: block.is_error === true,
        ...parentFields(parentToolUseId),
      })
      state.toolNames.delete(toolCallId)
    }
    return events
  }
  if (message.type === "result") {
    if (message.subtype !== "success" || message.is_error) {
      const failure = message.subtype === "success" ? message.result : message.subtype
      events.push({ type: "run.failed", message: failure })
      return events
    }
    const result = message.result.trim()
    if (result.length > 0 && result !== state.lastText.trim()) {
      events.push({ type: "message.completed", text: message.result })
    }
    events.push({
      type: "usage.updated",
      usage: { modelUsage: message.modelUsage, totalCostUsd: message.total_cost_usd },
    })
    // 还有后台任务（工作流、后台子 agent）在跑：主回合结束了，run 还没有。
    // 它们跑完后 CLI 会在同一个会话里续一个回合，那个回合的 result 才是结束。
    if (hasPendingTasks(state.tasks)) return events
    events.push({ type: "run.completed" })
  }
  return events
}

/** 把 Task/Agent tool_use 转成 subagent.started，并登记到状态表。 */
function subagentStarted(
  toolCallId: string,
  toolName: string,
  input: unknown,
  parentToolUseId: string | null,
  state: NormalizeState,
): AgentEvent {
  const fields = asRecord(input)
  const description = asText(fields?.description)
  const prompt = asText(fields?.prompt)
  const model = asText(fields?.model)
  const name = asText(fields?.subagent_type) ?? description ?? toolName
  const info: SubagentInfo = { name }
  if (description !== undefined) info.description = description
  if (model !== undefined) info.model = model
  state.subagents.set(toolCallId, info)
  return {
    type: "subagent.started",
    toolCallId,
    name,
    ...(description === undefined ? {} : { description }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(model === undefined ? {} : { model }),
    ...parentFields(parentToolUseId),
  }
}

/** 有专门说明的快速模式不可用原因；其余原因只说没有生效。 */
const FAST_REASONS = new Set(["extra_usage_disabled", "free", "model_not_allowed", "cooldown"])

/**
 * 选了快速模式时，看 init 消息里快速模式到底开没开：没开就给一条会话提示，说明这一轮按标准速度运行。
 * 原因来自 fast_mode_disabled_reason（账号没开额外用量、免费计划、模型不支持……），限流冷却时是 cooldown 状态。
 */
export function fastModeNotice(
  message: SDKMessage,
): Extract<AgentEvent, { type: "notice" }> | null {
  if (message.type !== "system" || message.subtype !== "init") return null
  const state = message.fast_mode_state
  if (state === undefined || state === "on") return null
  const reason = state === "cooldown" ? "cooldown" : message.fast_mode_disabled_reason
  return {
    type: "notice",
    level: "info",
    key: reason && FAST_REASONS.has(reason) ? `fast.unavailable.${reason}` : "fast.unavailable",
  }
}

/** 工具结果里的文字：字符串或文本块数组。 */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return asText(content.trim())
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((part) => {
    const text = asText(asRecord(part)?.text)
    return text ? [text] : []
  })
  return asText(parts.join("\n").trim())
}
