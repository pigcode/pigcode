/** 把线程事件的 payload 解析成时间线组件需要的结构；字段名兼容各 Agent 的变体。 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { ApprovalDecision, ApprovalRequest } from "./approval-card"
import type { QuestionRequestView, QuestionView } from "./question-card"
import type { SubagentCall, SubagentStatus } from "./subagent-card"
import type { ToolCall, ToolStatus } from "./tool-meta"

/** 把 unknown payload 收窄为对象。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 把 unknown payload 收窄为数组。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : []
}

/** 只接受字符串字段。 */
export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** 只接受有限数字字段。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 把任意 payload 值转成可读文本。 */
function displayValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null || value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** 解析工具调用事件；字段名兼容常见的 tool / command / output 变体。 */
export function toolFromEvent(event: ThreadEvent, status: ToolStatus): ToolCall | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  const name = asText(payload.name) ?? asText(payload.tool) ?? asText(payload.title) ?? "tool"
  const id =
    asText(payload.id) ??
    asText(payload.toolCallId) ??
    asText(payload.callId) ??
    `tool-${event.seq}`
  const exitCode = asNumber(payload.exitCode)
  const inputValue = payload.input ?? payload.command ?? payload.arguments
  const outputValue = payload.output ?? payload.result
  return {
    id,
    name,
    status,
    input: displayValue(inputValue),
    output: displayValue(outputValue),
    ...(inputValue === undefined ? {} : { inputValue }),
    ...(outputValue === undefined ? {} : { outputValue }),
    ...(event.type === "tool.started" ? { startedAt: event.createdAt } : {}),
    ...(event.type === "tool.completed" ? { endedAt: event.createdAt } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}

/** 合并同一工具的 started / completed 事件。 */
function mergeTool(existing: ToolCall | undefined, next: ToolCall): ToolCall {
  if (!existing) return next
  const startedAt = existing.startedAt ?? next.startedAt
  const endedAt = next.endedAt ?? existing.endedAt
  const exitCode = next.exitCode ?? existing.exitCode
  const inputValue = next.inputValue ?? existing.inputValue
  const outputValue = next.outputValue ?? existing.outputValue
  return {
    id: existing.id,
    name: next.name === "tool" ? existing.name : next.name,
    status: next.status,
    input: next.input ?? existing.input,
    output: next.output ?? existing.output,
    ...(inputValue === undefined ? {} : { inputValue }),
    ...(outputValue === undefined ? {} : { outputValue }),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}

/** 收集工具最终状态；渲染时只输出一张卡片。 */
export function collectTools(events: ThreadEvent[]): Map<string, ToolCall> {
  const tools = new Map<string, ToolCall>()
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.completed") continue
    const payload = asRecord(event.payload)
    const failed =
      payload?.error !== undefined || payload?.status === "failed" || payload?.isError === true
    const status: ToolStatus =
      event.type === "tool.started" ? "running" : failed ? "failed" : "completed"
    const next = toolFromEvent(event, status)
    if (!next) continue
    tools.set(next.id, mergeTool(tools.get(next.id), next))
  }
  return tools
}

/** 解析审批请求。 */
export function approvalFromEvent(event: ThreadEvent): ApprovalRequest | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  const plan =
    asText(payload.toolName) === "ExitPlanMode" ? asText(asRecord(payload.input)?.plan) : undefined
  return {
    id: asText(payload.id) ?? asText(payload.requestId) ?? `approval-${event.seq}`,
    title: asText(payload.title),
    description: asText(payload.description) ?? asText(payload.reason) ?? asText(payload.question),
    command: displayValue(payload.command),
    ...(plan ? { plan } : {}),
  }
}

/** 把审批决议字段归一化为本地联合类型。 */
function asDecision(value: unknown): ApprovalDecision | undefined {
  switch (value) {
    case "allow-once":
    case "allow_once":
    case "allowOnce":
      return "allow-once"
    case "allow-for-session":
    case "allow_for_session":
    case "allowSession":
      return "allow-for-session"
    case "deny":
    case "denied":
      return "deny"
    default:
      return undefined
  }
}

/** 收集已处理的审批请求。 */
export function collectResolved(events: ThreadEvent[]): Map<string, ApprovalDecision> {
  const resolved = new Map<string, ApprovalDecision>()
  for (const event of events) {
    if (event.type !== "approval.resolved") continue
    const payload = asRecord(event.payload)
    if (!payload) continue
    const id = asText(payload.id) ?? asText(payload.requestId)
    const decision =
      asDecision(payload.decision) ?? asDecision(payload.action) ?? asDecision(payload.outcome)
    if (id && decision) resolved.set(id, decision)
  }
  return resolved
}

/** 解析 question.requested 事件。 */
export function questionFromEvent(event: ThreadEvent): QuestionRequestView | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  const id = asText(payload.id) ?? asText(payload.requestId)
  if (!id) return undefined
  const questions: QuestionView[] = []
  for (const entry of asArray(payload.questions)) {
    const record = asRecord(entry)
    const question = asText(record?.question)
    if (!record || !question) continue
    questions.push({
      question,
      header: asText(record.header),
      multiSelect: record.multiSelect === true,
      options: asArray(record.options).flatMap((option) => {
        const value = asRecord(option)
        const label = asText(value?.label)
        return label ? [{ label, description: asText(value?.description) }] : []
      }),
    })
  }
  return questions.length > 0 ? { id, questions } : undefined
}

/** 收集已回答的问题：请求 id → 每个问题的答案。 */
export function collectAnswers(events: ThreadEvent[]): Map<string, string[]> {
  const answers = new Map<string, string[]>()
  for (const event of events) {
    if (event.type !== "question.answered") continue
    const payload = asRecord(event.payload)
    const id = asText(payload?.id) ?? asText(payload?.requestId)
    if (!id) continue
    answers.set(
      id,
      asArray(payload?.answers).map((answer) => (typeof answer === "string" ? answer : "")),
    )
  }
  return answers
}

/** 解析子 agent 完成状态；缺失时按 isError 推导。 */
function asSubagentStatus(value: unknown, isError: boolean): SubagentStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "interrupted":
      return value
    default:
      return isError ? "failed" : "completed"
  }
}

/** 子 agent 交回的结果：字符串、文本块数组或带 content 的对象，取出其中的文字。 */
function subagentOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (Array.isArray(value)) {
    const text = value
      .map((block) => (typeof block === "string" ? block : asText(asRecord(block)?.text)))
      .filter((part): part is string => Boolean(part))
      .join("\n\n")
    return text.trim() || undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  return subagentOutput(record.content) ?? asText(record.text) ?? asText(record.result)
}

/** 判断事件是否属于某个子 agent；这类事件只在卡片内部展示。 */
export function isParentScoped(type: ThreadEvent["type"]): boolean {
  return (
    type === "message.completed" ||
    type === "reasoning.completed" ||
    type === "tool.started" ||
    type === "tool.completed"
  )
}

/** 收集子 agent 卡片及其内部事件。 */
export function collectSubagents(events: ThreadEvent[]): Map<string, SubagentCall> {
  const children = new Map<string, ThreadEvent[]>()
  for (const event of events) {
    if (!isParentScoped(event.type)) continue
    const payload = asRecord(event.payload)
    const parent = asText(payload?.parentToolUseId)
    if (!parent) continue
    const list = children.get(parent) ?? []
    list.push(event)
    children.set(parent, list)
  }

  const subagents = new Map<string, SubagentCall>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = asRecord(event.payload)
    if (!payload) continue
    const id = asText(payload.toolCallId) ?? asText(payload.id)
    if (!id) continue
    if (event.type === "subagent.started") {
      const entry: SubagentCall = {
        id,
        name: asText(payload.name) ?? id,
        status: "running",
        events: children.get(id) ?? [],
        runId: event.runId,
      }
      const description = asText(payload.description)
      if (description) entry.description = description
      const prompt = asText(payload.prompt)
      if (prompt) entry.prompt = prompt
      const model = asText(payload.model)
      if (model) entry.model = model
      subagents.set(id, entry)
      continue
    }
    if (event.type === "subagent.completed") {
      const entry = subagents.get(id)
      if (!entry) continue
      entry.status = asSubagentStatus(payload.status, payload.isError === true)
      const output = subagentOutput(payload.output)
      if (output) entry.output = output
    }
  }
  return subagents
}
