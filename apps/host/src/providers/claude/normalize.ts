/** 把 Claude Agent SDK 消息映射为 Pigcode 规范化事件。 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderEvent } from "@pigcode/contracts"

/** 子 agent 的展示信息；由 Task/Agent tool_use 创建，tool_result 时移除。 */
interface SubagentInfo {
  name: string
  description?: string
  model?: string
}

/** 单次 run 内的归一化状态；记录已流式文本、工具名与活跃子 agent。 */
export interface NormalizeState {
  streamedText: string
  toolNames: Map<string, string>
  subagents: Map<string, SubagentInfo>
}

/** 创建一次 run 专属的归一化状态。 */
export function createNormalizeState(): NormalizeState {
  return { streamedText: "", toolNames: new Map(), subagents: new Map() }
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
export function normalizeSdkMessage(message: SDKMessage, state: NormalizeState): ProviderEvent[] {
  const events: ProviderEvent[] = []
  if (message.type === "system" && message.subtype === "init") {
    events.push({ type: "session.started", nativeSessionId: message.session_id })
    return events
  }
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
        events.push({
          type: "tool.started",
          toolCallId: block.id,
          name: block.name,
          input: block.input,
          ...parentFields(parentToolUseId),
        })
      } else if (block.type === "text" && parentToolUseId) {
        // 子 agent 的文本不冒充主助手消息，带 parent 归入对应卡片。
        if (block.text.trim().length > 0) {
          events.push({
            type: "message.completed",
            text: block.text,
            ...parentFields(parentToolUseId),
          })
        }
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
    if (message.result.trim().length > 0) {
      events.push({ type: "message.completed", text: message.result })
    }
    events.push({
      type: "usage.updated",
      usage: { modelUsage: message.modelUsage, totalCostUsd: message.total_cost_usd },
    })
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
): ProviderEvent {
  const fields = asRecord(input)
  const description = asText(fields?.description)
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
    ...(model === undefined ? {} : { model }),
    ...parentFields(parentToolUseId),
  }
}
