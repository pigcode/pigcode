/** 把 Codex app-server 通知映射为 Pigcode 规范化事件。 */
import type { ProviderEvent } from "@pigcode/contracts"

/** 收窄后的普通对象，避免在映射中散落类型断言。 */
type UnknownRecord = Record<string, unknown>

/** 把未知值收窄为普通对象；数组与 null 视为无效。 */
function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

/** 读取字符串字段；非字符串一律忽略。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** 把一条 Codex 通知映射为零到多条规范化事件；未知方法返回空数组。 */
export function normalizeCodexNotification(method: string, params: unknown): ProviderEvent[] {
  const record = asRecord(params)
  if (!record) return []
  switch (method) {
    case "item/agentMessage/delta": {
      const delta = asString(record.delta)
      return delta === undefined ? [] : [{ type: "message.delta", text: delta }]
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = asString(record.delta)
      return delta ? [{ type: "reasoning.delta", text: delta }] : []
    }
    case "item/commandExecution/outputDelta": {
      const delta = asString(record.delta)
      const itemId = asString(record.itemId)
      return delta === undefined || !itemId
        ? []
        : [{ type: "tool.outputDelta", toolCallId: itemId, delta }]
    }
    case "item/started":
      return normalizeItem(record.item, true)
    case "item/completed":
      return normalizeItem(record.item, false)
    case "turn/plan/updated":
      return normalizePlan(record)
    case "thread/tokenUsage/updated":
      return normalizeUsage(record)
    case "turn/completed":
      return normalizeTurn(record)
    default:
      return []
  }
}

/** 映射 item/started 与 item/completed；不支持的类型不产生事件。 */
function normalizeItem(value: unknown, started: boolean): ProviderEvent[] {
  const item = asRecord(value)
  if (!item) return []
  const id = asString(item.id)
  const type = asString(item.type)
  if (!id || !type) return []

  if (type === "agentMessage") {
    // 起始通知只有 item 元数据；完整文本在完成时一次性写入事件日志。
    if (started) return []
    const text = asString(item.text)
    return text === undefined ? [] : [{ type: "message.completed", text }]
  }

  if (type === "commandExecution") {
    if (started) {
      return [{ type: "tool.started", toolCallId: id, name: "Bash", input: item.command ?? null }]
    }
    return [
      {
        type: "tool.completed",
        toolCallId: id,
        name: "Bash",
        output: item.aggregatedOutput ?? "",
        isError: isItemError(item),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      },
    ]
  }

  if (type === "fileChange") {
    if (started) {
      return [
        { type: "tool.started", toolCallId: id, name: "ApplyPatch", input: item.changes ?? null },
      ]
    }
    return [
      {
        type: "tool.completed",
        toolCallId: id,
        name: "ApplyPatch",
        output: item.changes ?? "",
        isError: isItemError(item),
      },
    ]
  }

  if (type === "mcpToolCall") {
    // 名字与 Claude 的 MCP 工具一致（mcp__server__tool），时间线按同一套规则展示。
    const name = `mcp__${asString(item.server) ?? "mcp"}__${asString(item.tool) ?? "tool"}`
    if (started)
      return [{ type: "tool.started", toolCallId: id, name, input: item.arguments ?? null }]
    const result = asRecord(item.result)
    const error = asRecord(item.error)
    return [
      {
        type: "tool.completed",
        toolCallId: id,
        name,
        output: result?.content ?? asString(error?.message) ?? "",
        isError: item.status === "failed" || error !== undefined,
      },
    ]
  }

  if (type === "reasoning") {
    if (started) return []
    const text = reasoningText(item)
    return text ? [{ type: "reasoning.completed", text }] : []
  }

  if (type === "webSearch") {
    const input = { query: asString(item.query) ?? "" }
    return started
      ? [{ type: "tool.started", toolCallId: id, name: "WebSearch", input }]
      : [{ type: "tool.completed", toolCallId: id, name: "WebSearch", output: "", isError: false }]
  }

  if (type === "subAgentActivity") {
    return normalizeSubagentActivity(item, id)
  }

  if (type === "collabAgentToolCall" || type === "collabToolCall") {
    return normalizeCollabToolCall(item, id)
  }

  return []
}

/** 映射 subAgentActivity：started → 开始，completed/interrupted → 结束。 */
function normalizeSubagentActivity(item: UnknownRecord, id: string): ProviderEvent[] {
  const kind = asString(item.kind)
  if (kind === "started") {
    const model = asString(item.model)
    const name = asString(item.agentPath) ?? asString(item.agentThreadId) ?? "subagent"
    return [
      {
        type: "subagent.started",
        toolCallId: id,
        name,
        ...(model === undefined ? {} : { model }),
      },
    ]
  }
  if (kind === "completed" || kind === "interrupted") {
    return [
      {
        type: "subagent.completed",
        toolCallId: id,
        isError: false,
        status: kind,
      },
    ]
  }
  return []
}

/** 映射 collab 工具调用：每个 receiver thread 产生一张子 agent 卡片。 */
function normalizeCollabToolCall(item: UnknownRecord, id: string): ProviderEvent[] {
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
  const name = asString(item.tool) ?? "subagent"
  const description = asString(item.prompt)
  const model = asString(item.model)
  const events: ProviderEvent[] = []
  for (const receiver of receivers) {
    if (typeof receiver !== "string" || receiver.length === 0) continue
    events.push({
      type: "subagent.started",
      toolCallId: `${id}:${receiver}`,
      name,
      ...(description === undefined ? {} : { description }),
      ...(model === undefined ? {} : { model }),
    })
  }
  return events
}

/** 推理条目的文字：优先用摘要，没有摘要时用原始推理内容。 */
function reasoningText(item: UnknownRecord): string | undefined {
  for (const field of [item.summary, item.content]) {
    const parts = Array.isArray(field)
      ? field.filter((part): part is string => typeof part === "string" && part.trim() !== "")
      : []
    if (parts.length > 0) return parts.join("\n\n")
  }
  return undefined
}

/** 判断工具条目是否以错误结束；有 exitCode 时以退出码为准。 */
function isItemError(item: UnknownRecord): boolean {
  if (typeof item.exitCode === "number") return item.exitCode !== 0
  return item.status === "failed" || item.status === "declined"
}

/** 映射 turn/plan/updated；兼容 plan 与 steps 两种字段名。 */
function normalizePlan(record: UnknownRecord): ProviderEvent[] {
  const plan = Array.isArray(record.plan)
    ? record.plan
    : Array.isArray(record.steps)
      ? record.steps
      : null
  if (!plan) return []
  return [
    {
      type: "plan.updated",
      explanation: asString(record.explanation) ?? null,
      plan,
    },
  ]
}

/** 映射 thread/tokenUsage/updated；usage 保留 provider 原始结构。 */
function normalizeUsage(record: UnknownRecord): ProviderEvent[] {
  const usage = record.tokenUsage ?? record.usage
  if (usage === undefined) return []
  return [{ type: "usage.updated", usage }]
}

/** 依据 turn.status 映射 run 终态；inProgress 等中间状态不产生事件。 */
function normalizeTurn(record: UnknownRecord): ProviderEvent[] {
  const turn = asRecord(record.turn)
  const status = asString(turn?.status) ?? asString(record.status)
  if (status === "completed") return [{ type: "run.completed" }]
  if (status === "interrupted") return [{ type: "run.interrupted" }]
  if (status === "failed") return [{ type: "run.failed", message: turnErrorMessage(turn) }]
  return []
}

/** 从 turn.error 中取出可展示的错误消息。 */
function turnErrorMessage(turn: UnknownRecord | undefined): string {
  const error = turn?.error
  if (typeof error === "string" && error.length > 0) return error
  const record = asRecord(error)
  return (record ? asString(record.message) : undefined) ?? "codex turn failed"
}
