/** 把 Claude Agent SDK 消息映射为 Pigcode 规范化事件。 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderEvent } from "@pigcode/contracts"

/** 单次 run 内的归一化状态；记录已流式文本与 tool_use id 到名称的映射。 */
export interface NormalizeState {
  streamedText: string
  toolNames: Map<string, string>
}

/** 创建一次 run 专属的归一化状态。 */
export function createNormalizeState(): NormalizeState {
  return { streamedText: "", toolNames: new Map() }
}

/** 一条 SDK 消息可能产生零到多个事件。 */
export function normalizeSdkMessage(message: SDKMessage, state: NormalizeState): ProviderEvent[] {
  const events: ProviderEvent[] = []
  if (message.type === "system" && message.subtype === "init") {
    events.push({ type: "session.started", nativeSessionId: message.session_id })
    return events
  }
  if (message.type === "stream_event") {
    const event = message.event
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      state.streamedText += event.delta.text
      events.push({ type: "message.delta", text: event.delta.text })
    }
    return events
  }
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        state.toolNames.set(block.id, block.name)
        events.push({
          type: "tool.started",
          toolCallId: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }
    return events
  }
  if (message.type === "user") {
    const content = message.message.content
    if (!Array.isArray(content)) return events
    for (const block of content) {
      if (block.type === "tool_result") {
        const toolCallId = block.tool_use_id
        events.push({
          type: "tool.completed",
          toolCallId,
          name: state.toolNames.get(toolCallId) ?? "tool",
          output: block.content,
          isError: block.is_error === true,
        })
        state.toolNames.delete(toolCallId)
      }
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
