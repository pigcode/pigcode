/** 子代理卡片；用 details 折叠展示子 agent 的消息与工具调用。 */
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { Bot, Wrench } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import type { ToolCall, ToolStatus } from "./tool-card"

/** 子 agent 的生命周期状态。 */
export type SubagentStatus = "running" | "completed" | "failed" | "interrupted"

/** 时间线里一张子 agent 卡片需要的数据。 */
export interface SubagentCall {
  id: string
  name: string
  description?: string
  model?: string
  status: SubagentStatus
  events: ThreadEvent[]
}

const STATUS_KEYS = {
  running: "chat.tool.running",
  completed: "chat.tool.completed",
  failed: "chat.tool.failed",
  interrupted: "tabs.status.interrupted",
} as const

/** 把 unknown payload 收窄为对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 只接受非空字符串。 */
function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
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

/** 收集子事件里的工具调用，按 id 合并 started/completed。 */
function collectTools(events: ThreadEvent[]): Map<string, ToolCall> {
  const tools = new Map<string, ToolCall>()
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.completed") continue
    const payload = asRecord(event.payload)
    if (!payload) continue
    const id =
      asText(payload.id) ??
      asText(payload.toolCallId) ??
      asText(payload.callId) ??
      `tool-${event.seq}`
    const name = asText(payload.name) ?? asText(payload.tool) ?? asText(payload.title) ?? "tool"
    const failed = payload.error !== undefined || payload.status === "failed"
    const status: ToolStatus =
      event.type === "tool.started" ? "running" : failed ? "failed" : "completed"
    const existing = tools.get(id)
    tools.set(id, {
      id,
      name: existing && name === "tool" ? existing.name : name,
      status,
      input:
        displayValue(payload.input) ??
        displayValue(payload.command) ??
        displayValue(payload.arguments) ??
        existing?.input,
      output: displayValue(payload.output) ?? displayValue(payload.result) ?? existing?.output,
    })
  }
  return tools
}

/** 按 seq 渲染子 agent 的紧凑消息与工具行。 */
function SubagentEvents({ events }: { events: ThreadEvent[] }) {
  const { t } = useLocale()
  const tools = collectTools(events)
  const renderedTools = new Set<string>()
  const nodes: ReactNode[] = []

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = asRecord(event.payload)
    if (event.type === "message.completed") {
      const text = asText(payload?.text)
      if (text) {
        nodes.push(
          <p key={`${event.seq}-${event.type}`} className="subagent-message">
            {text}
          </p>,
        )
      }
      continue
    }
    if (event.type !== "tool.started" && event.type !== "tool.completed") continue
    const id =
      asText(payload?.id) ??
      asText(payload?.toolCallId) ??
      asText(payload?.callId) ??
      `tool-${event.seq}`
    if (renderedTools.has(id)) continue
    renderedTools.add(id)
    const tool = tools.get(id)
    if (!tool) continue
    nodes.push(
      <div key={`tool-${id}`} className="subagent-line subagent-tool" data-status={tool.status}>
        <Wrench className="ic ic-sm" aria-hidden="true" />
        <span className="subagent-tool-name">
          {tool.name === "tool" ? t("chat.tool.unknown") : tool.name}
        </span>
        <span className={`subagent-tool-status ${tool.status}`}>{t(STATUS_KEYS[tool.status])}</span>
      </div>,
    )
  }
  return <>{nodes}</>
}

/** 渲染子 agent；默认折叠，点击标题展开子消息。 */
export function SubagentCard({ subagent }: { subagent: SubagentCall }) {
  const { t } = useLocale()
  return (
    <details className="subagent-card" data-status={subagent.status}>
      <summary className="subagent-head">
        <Bot className="ic ic-sm" aria-hidden="true" />
        <span className="subagent-name">{subagent.name}</span>
        {subagent.description ? (
          <span className="subagent-description">{subagent.description}</span>
        ) : null}
        <span className="grow" />
        <span className={`subagent-status ${subagent.status}`}>
          {t(STATUS_KEYS[subagent.status])}
        </span>
      </summary>
      <div className="subagent-body">
        {subagent.events.length > 0 ? (
          <SubagentEvents events={subagent.events} />
        ) : (
          <div className="subagent-empty muted">{t("chat.empty")}</div>
        )}
      </div>
    </details>
  )
}
