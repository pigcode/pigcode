/** 按事件顺序渲染消息、工具、审批、计划与文件变更。 */
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { AlertTriangle } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { ApprovalCard, type ApprovalDecision, type ApprovalRequest } from "./approval-card"
import { DiffSummary, type DiffFile, type FileChangeSummary } from "./diff-summary"
import { AssistantMessage, MessageText, UserMessage } from "./message-item"
import { PlanCard, type PlanStep, type PlanStepStatus, type PlanUpdate } from "./plan-card"
import { SubagentCard, type SubagentCall, type SubagentStatus } from "./subagent-card"
import { ToolCard, type ToolCall, type ToolStatus } from "./tool-card"

/** 消息列表需要的线程事件与交互回调。 */
export interface MessageListProps {
  events: ThreadEvent[]
  streamingText?: string
  onApproval: (requestId: string, decision: ApprovalDecision) => void
  onViewTool?: ((tool: ToolCall) => void) | undefined
  onViewDiff?: ((summary: FileChangeSummary) => void) | undefined
}

/** 把 unknown payload 收窄为对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 把 unknown payload 收窄为数组。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : []
}

/** 只接受字符串字段。 */
function asText(value: unknown): string | undefined {
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
function toolFromEvent(event: ThreadEvent, status: ToolStatus): ToolCall | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  const name = asText(payload.name) ?? asText(payload.tool) ?? asText(payload.title) ?? "tool"
  const id =
    asText(payload.id) ??
    asText(payload.toolCallId) ??
    asText(payload.callId) ??
    `tool-${event.seq}`
  return {
    id,
    name,
    status,
    input:
      displayValue(payload.input) ??
      displayValue(payload.command) ??
      displayValue(payload.arguments),
    output: displayValue(payload.output) ?? displayValue(payload.result),
  }
}

/** 合并同一工具的 started / completed 事件。 */
function mergeTool(existing: ToolCall | undefined, next: ToolCall): ToolCall {
  if (!existing) return next
  return {
    id: existing.id,
    name: next.name === "tool" ? existing.name : next.name,
    status: next.status,
    input: next.input ?? existing.input,
    output: next.output ?? existing.output,
  }
}

/** 收集工具最终状态；渲染时只输出一张卡片。 */
function collectTools(events: ThreadEvent[]): Map<string, ToolCall> {
  const tools = new Map<string, ToolCall>()
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.completed") continue
    const payload = asRecord(event.payload)
    const failed = payload?.error !== undefined || payload?.status === "failed"
    const status: ToolStatus =
      event.type === "tool.started" ? "running" : failed ? "failed" : "completed"
    const next = toolFromEvent(event, status)
    if (!next) continue
    tools.set(next.id, mergeTool(tools.get(next.id), next))
  }
  return tools
}

/** 解析审批请求。 */
function approvalFromEvent(event: ThreadEvent): ApprovalRequest | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  return {
    id: asText(payload.id) ?? asText(payload.requestId) ?? `approval-${event.seq}`,
    title: asText(payload.title),
    description: asText(payload.description) ?? asText(payload.reason) ?? asText(payload.question),
    command: displayValue(payload.command),
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
function collectResolved(events: ThreadEvent[]): Map<string, ApprovalDecision> {
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

/** 归一化计划步骤状态。 */
function asPlanStatus(value: unknown): PlanStepStatus {
  switch (value) {
    case "completed":
    case "done":
      return "completed"
    case "in-progress":
    case "in_progress":
    case "active":
    case "running":
      return "in-progress"
    default:
      return "pending"
  }
}

/** 解析 plan.updated 事件；支持字符串步骤和对象步骤。 */
function planFromEvent(event: ThreadEvent): PlanUpdate | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  const rawSteps =
    asArray(payload.steps).length > 0 ? asArray(payload.steps) : asArray(payload.plan)
  const steps: PlanStep[] = []
  for (const [index, entry] of rawSteps.entries()) {
    if (typeof entry === "string") {
      steps.push({ text: entry, status: "pending" })
      continue
    }
    const record = asRecord(entry)
    if (!record) continue
    steps.push({
      text: asText(record.text) ?? asText(record.step) ?? asText(record.title) ?? `#${index + 1}`,
      status: asPlanStatus(record.status),
    })
  }
  if (steps.length === 0 && typeof payload.text === "string") {
    for (const line of payload.text.split("\n")) {
      const text = line.trim()
      if (text) steps.push({ text, status: "pending" })
    }
  }
  if (steps.length === 0) return undefined
  return { title: asText(payload.title) ?? asText(payload.explanation), steps }
}

/** 解析 diff 文本或行数组。 */
function parseDiffLines(value: unknown): string[] {
  if (typeof value === "string") return value.split("\n").filter((line) => line.length > 0)
  if (!Array.isArray(value)) return []
  const lines: string[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry === "string") lines.push(entry)
  }
  return lines
}

/** 解析 file.changed 事件。 */
function diffFromEvent(event: ThreadEvent): FileChangeSummary | undefined {
  const payload = asRecord(event.payload)
  if (!payload) return undefined
  const entries =
    asArray(payload.files).length > 0 ? asArray(payload.files) : asArray(payload.changes)
  const files: DiffFile[] = []
  for (const entry of entries) {
    if (typeof entry === "string") {
      files.push({ path: entry, lines: [] })
      continue
    }
    const record = asRecord(entry)
    if (!record) continue
    const path = asText(record.path) ?? asText(record.file) ?? asText(record.name)
    if (!path) continue
    files.push({ path, lines: parseDiffLines(record.diff ?? record.patch ?? record.lines) })
  }
  if (files.length === 0) {
    const path = asText(payload.path) ?? asText(payload.file) ?? asText(payload.name)
    if (path) files.push({ path, lines: parseDiffLines(payload.diff ?? payload.patch) })
  }
  if (files.length === 0) return undefined

  let additions = asNumber(payload.additions)
  let deletions = asNumber(payload.deletions)
  if (additions === undefined || deletions === undefined) {
    let countedAdditions = 0
    let countedDeletions = 0
    for (const file of files) {
      for (const line of file.lines) {
        if (line.startsWith("+")) countedAdditions += 1
        else if (line.startsWith("-") || line.startsWith("−")) countedDeletions += 1
      }
    }
    additions = additions ?? countedAdditions
    deletions = deletions ?? countedDeletions
  }
  return { files, additions, deletions }
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

/** 判断事件是否属于某个子 agent；这类事件只在卡片内部展示。 */
function isParentScoped(type: ThreadEvent["type"]): boolean {
  return type === "message.completed" || type === "tool.started" || type === "tool.completed"
}

/** 收集子 agent 卡片及其内部事件。 */
function collectSubagents(events: ThreadEvent[]): Map<string, SubagentCall> {
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
      }
      const description = asText(payload.description)
      if (description) entry.description = description
      const model = asText(payload.model)
      if (model) entry.model = model
      subagents.set(id, entry)
      continue
    }
    if (event.type === "subagent.completed") {
      const entry = subagents.get(id)
      if (entry) entry.status = asSubagentStatus(payload.status, payload.isError === true)
    }
  }
  return subagents
}

/** 判断线程是否还有未处理的审批请求。 */
export function hasPendingApproval(events: ThreadEvent[]): boolean {
  const resolved = collectResolved(events)
  for (const event of events) {
    if (event.type !== "approval.requested") continue
    const request = approvalFromEvent(event)
    if (request && !resolved.has(request.id)) return true
  }
  return false
}

/** 渲染整条消息时间线，最后追加流式文本。 */
export function MessageList({
  events,
  streamingText = "",
  onApproval,
  onViewTool,
  onViewDiff,
}: MessageListProps) {
  const { t } = useLocale()
  const tools = collectTools(events)
  const resolved = collectResolved(events)
  const subagents = collectSubagents(events)
  const sorted = [...events].sort((left, right) => left.seq - right.seq)
  const nodes: ReactNode[] = []
  const renderedTools = new Set<string>()
  const renderedSubagents = new Set<string>()

  for (const event of sorted) {
    const key = `${event.seq}-${event.type}`
    const payload = asRecord(event.payload)
    // 子 agent 的消息与工具已在卡片内部按 seq 渲染，跳过顶层重复展示。
    if (isParentScoped(event.type) && asText(payload?.parentToolUseId)) continue
    if (event.type === "subagent.started") {
      const id = asText(payload?.toolCallId) ?? asText(payload?.id)
      const subagent = id ? subagents.get(id) : undefined
      if (subagent && !renderedSubagents.has(subagent.id)) {
        renderedSubagents.add(subagent.id)
        nodes.push(<SubagentCard key={`subagent-${subagent.id}`} subagent={subagent} />)
      }
      continue
    }
    if (event.type === "subagent.completed") continue
    if (event.type === "run.started") {
      const text = asText(payload?.text)
      if (text) nodes.push(<UserMessage key={key} text={text} />)
      continue
    }
    if (event.type === "message.completed") {
      const text = asText(payload?.text)
      if (!text) continue
      nodes.push(
        asText(payload?.role) === "user" ? (
          <UserMessage key={key} text={text} />
        ) : (
          <AssistantMessage key={key}>
            <MessageText text={text} />
          </AssistantMessage>
        ),
      )
      continue
    }
    if (event.type === "tool.started" || event.type === "tool.completed") {
      const status: ToolStatus =
        event.type === "tool.started"
          ? "running"
          : payload?.error !== undefined || payload?.status === "failed"
            ? "failed"
            : "completed"
      const next = toolFromEvent(event, status)
      if (!next || renderedTools.has(next.id)) continue
      renderedTools.add(next.id)
      nodes.push(
        <ToolCard key={`tool-${next.id}`} tool={tools.get(next.id) ?? next} onView={onViewTool} />,
      )
      continue
    }
    if (event.type === "approval.requested") {
      const request = approvalFromEvent(event)
      if (!request) continue
      nodes.push(
        <ApprovalCard
          key={`approval-${request.id}`}
          request={request}
          resolved={resolved.get(request.id)}
          onApproval={onApproval}
        />,
      )
      continue
    }
    if (event.type === "plan.updated") {
      const plan = planFromEvent(event)
      if (plan) nodes.push(<PlanCard key={key} plan={plan} />)
      continue
    }
    if (event.type === "file.changed") {
      const summary = diffFromEvent(event)
      if (summary) nodes.push(<DiffSummary key={key} summary={summary} onView={onViewDiff} />)
      continue
    }
    if (event.type === "run.failed") {
      nodes.push(
        <AssistantMessage key={key}>
          <div className="event-line t-bad">
            <AlertTriangle className="ic ic-sm" aria-hidden="true" />
            {asText(payload?.message) ?? t("chat.error")}
          </div>
        </AssistantMessage>,
      )
    }
  }

  if (streamingText) {
    nodes.push(
      <AssistantMessage key="streaming">
        <MessageText text={streamingText} />
        <span className="stream-cursor" aria-label={t("chat.streaming")} />
      </AssistantMessage>,
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="msgs">
        <div className="chat-empty">{t("chat.empty")}</div>
      </div>
    )
  }
  return <div className="msgs">{nodes}</div>
}
