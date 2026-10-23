/**
 * 子 agent 行（参照 ZCode 的 agent）：「子智能体 · 类型 · 任务说明」，运行中扫光并显示它最新在做
 * 的事。主时间线不在原地展开子 agent 的过程，点击整行在标签页中打开；没有标签页可开时才能展开，
 * 显示任务、过程与交回的结果。
 */
import { memo } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { Bot } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { asRecord, asText, toolFromEvent } from "./event-parsers"
import { MessageText } from "./message-item"
import { readPath } from "./tool-fields"
import { toolFamily } from "./tool-identity"
import { commandText, toolPreview } from "./tool-meta"
import { ToolRow } from "./tool-row"
import { useConversationActions } from "./tools/common"

/** 子 agent 的生命周期状态。 */
export type SubagentStatus = "running" | "completed" | "failed" | "interrupted"

/** 时间线里一个子 agent 需要的数据。 */
export interface SubagentCall {
  id: string
  name: string
  description?: string
  /** 主 agent 交给它的完整任务。 */
  prompt?: string
  model?: string
  status: SubagentStatus
  events: ThreadEvent[]
  /** 子 agent 交回给主 agent 的结果。 */
  output?: string
  /** 派生它的 run；标签栏只自动展示最近一次 run 派生的子 agent。 */
  runId?: string | null
}

/** 子 agent 最新一次工具调用的简短描述：动作与对象。 */
function useLatestActivity(events: readonly ThreadEvent[]): string | null {
  const { t } = useLocale()
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (event.type !== "tool.started") continue
    const tool = toolFromEvent(event, "running")
    if (!tool) continue
    const family = toolFamily(tool.name)
    if (family === "file-read") {
      return `${t("chat.toolCall.read.reading")} ${readPath(tool) ?? ""}`.trim()
    }
    if (family === "shell") {
      return `${t("chat.toolCall.execute.running")} ${commandText(tool.input) ?? ""}`.trim()
    }
    if (family === "search") {
      return `${t("chat.toolCall.search.searching")} ${toolPreview(tool.input) ?? ""}`.trim()
    }
    return toolPreview(tool.input) ?? tool.name
  }
  return null
}

/** 子 agent 的过程：完成的消息按顺序列出。 */
function SubagentMessages({ events }: { events: readonly ThreadEvent[] }) {
  const messages = [...events]
    .sort((left, right) => left.seq - right.seq)
    .filter((event) => event.type === "message.completed")
    .map((event) => ({ key: event.seq, text: asText(asRecord(event.payload)?.text) ?? "" }))
    .filter((message) => message.text)
  if (messages.length === 0) return null
  return (
    <div className="subagent-section">
      {messages.map((message) => (
        <div key={message.key} className="md subagent-message">
          <MessageText text={message.text} />
        </div>
      ))}
    </div>
  )
}

/** 渲染一个子 agent。 */
export const AgentRow = memo(function AgentRow({ subagent }: { subagent: SubagentCall }) {
  const { t } = useLocale()
  const { onOpenSubagent } = useConversationActions()
  const running = subagent.status === "running"
  const activity = useLatestActivity(subagent.events)
  const title = subagent.description ?? subagent.prompt?.split("\n")[0] ?? ""
  const status =
    subagent.status === "failed"
      ? { label: t("chat.toolCall.status.failed"), tooltip: subagent.output }
      : subagent.status === "interrupted"
        ? { label: t("chat.toolCall.status.stopped") }
        : null
  return (
    <ToolRow
      id={`agent-${subagent.id}`}
      icon={Bot}
      kind={t("chat.toolCall.agent.label")}
      running={running}
      kindDetail={<span className="subagent-type">{subagent.name}</span>}
      separator={Boolean(title || (running && activity))}
      primary={running && activity ? <span className="truncate">{activity}</span> : title}
      status={status}
      title={subagent.prompt ?? title}
      className="subagent-row"
      dataStatus={subagent.status}
      action={
        onOpenSubagent
          ? {
              label: `${t("chat.subagent.open")} ${subagent.name}`,
              onActivate: () => onOpenSubagent(subagent.id),
            }
          : undefined
      }
    >
      {() => (
        <div className="tool-card subagent-card">
          {subagent.prompt ? (
            <div className="subagent-section">
              <span className="tool-card-label">{t("chat.toolCall.agent.prompt")}</span>
              <div className="subagent-prompt md">
                <MessageText text={subagent.prompt} />
              </div>
            </div>
          ) : null}
          <SubagentMessages events={subagent.events} />
          {subagent.output ? (
            <div className="subagent-section">
              <span className="tool-card-label">{t("chat.toolCall.agent.output")}</span>
              <div className="subagent-output md">
                <MessageText text={subagent.output} />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </ToolRow>
  )
})
