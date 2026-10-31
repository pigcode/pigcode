/**
 * 主 agent 派生的子代理在标签页里的完整视图：任务说明、按顺序的思考、过程消息与工具调用（和主
 * 时间线同样的工具行与分组），以及交回给主 agent 的结果。它属于主会话的这一轮，没有自己的输入框。
 */
import { useMemo, useState } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { Bot } from "lucide-react"
import { EmptyState, StatusDot, useLocale, type StatusTone } from "@pigcode/ui-primitives"
import { asRecord, asText, collectTools, toolFromEvent } from "./event-parsers"
import { MessageText } from "./message-item"
import type { SubagentCall } from "./subagent-card"
import { isHiddenTool } from "./tool-identity"
import { ConversationActionsContext, type ConversationActions } from "./tools"
import type { WorkItem } from "./turns"
import { groupTools } from "./work-groups"
import { WorkList } from "./work-list"

/** 子 agent 的过程：思考、完成的消息与合并后的工具调用，按 seq 排列，连续的同类工具合并。 */
export function subagentSteps(events: readonly ThreadEvent[]): WorkItem[] {
  const sorted = [...events].sort((left, right) => left.seq - right.seq)
  const tools = collectTools(sorted)
  const seen = new Set<string>()
  const steps: WorkItem[] = []
  for (const event of sorted) {
    const payload = asRecord(event.payload)
    if (event.type === "message.completed" || event.type === "reasoning.completed") {
      const text = asText(payload?.text)
      if (!text?.trim()) continue
      steps.push(
        event.type === "message.completed"
          ? { kind: "message", key: `msg-${event.seq}`, text }
          : { kind: "reasoning", key: `reasoning-${event.seq}`, text, durationMs: null },
      )
      continue
    }
    if (event.type !== "tool.started" && event.type !== "tool.completed") continue
    const tool = toolFromEvent(event, event.type === "tool.started" ? "running" : "completed")
    if (!tool || seen.has(tool.id) || isHiddenTool(tool.name)) continue
    seen.add(tool.id)
    steps.push({ kind: "tool", key: `tool-${tool.id}`, tool: tools.get(tool.id) ?? tool })
  }
  return groupTools(steps, (item) => (item.kind === "tool" ? item.tool : null)) as WorkItem[]
}

/** 主 agent 交给子 agent 的任务；超过四行时折叠，可以展开。 */
function SubagentTask({ text }: { text: string }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const long = text.split("\n").length > 4 || text.length > 320
  return (
    <div className="subagent-view-task" data-clamped={long && !open ? true : undefined}>
      <div className="subagent-view-task-text">{text}</div>
      {long ? (
        <button type="button" className="subagent-view-more" onClick={() => setOpen(!open)}>
          {open ? t("chat.message.collapse") : t("chat.message.expand")}
        </button>
      ) : null}
    </div>
  )
}

const STATUS_KEYS = {
  running: "chat.status.running",
  completed: "chat.tool.completed",
  failed: "chat.toolCall.status.failed",
  interrupted: "chat.toolCall.status.stopped",
} as const

/** 状态点的色调；和侧栏会话的同一种状态一样。 */
const STATUS_TONES: Record<SubagentCall["status"], StatusTone> = {
  running: "running",
  completed: "ready",
  failed: "error",
  interrupted: "idle",
}

/** 渲染派生子代理的过程与结果。 */
export function SubagentView({
  subagent,
  root,
  onOpenFile,
  onViewDiff,
}: {
  subagent: SubagentCall
  root?: string | undefined
  onOpenFile?: ((path: string) => void) | undefined
  onViewDiff?: ((path?: string) => void) | undefined
}) {
  const { t } = useLocale()
  const steps = useMemo(() => subagentSteps(subagent.events), [subagent.events])
  const actions = useMemo<ConversationActions>(
    () => ({ root, onOpenFile, onViewDiff }),
    [root, onOpenFile, onViewDiff],
  )
  return (
    <ConversationActionsContext.Provider value={actions}>
      <div className="msgs subagent-view" data-status={subagent.status}>
        <header className="subagent-view-head">
          <span className="subagent-icon" aria-hidden="true">
            <Bot className="ic ic-sm" />
          </span>
          <div className="subagent-view-title">
            <div className="subagent-view-name">
              {subagent.description ?? subagent.name}
              <span className="subagent-view-model">
                {[subagent.description ? subagent.name : null, subagent.model]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {subagent.prompt ? <SubagentTask text={subagent.prompt} /> : null}
          </div>
          <span className="subagent-status" data-status={subagent.status}>
            <StatusDot tone={STATUS_TONES[subagent.status]} />
            {t(STATUS_KEYS[subagent.status])}
          </span>
        </header>
        {steps.length === 0 ? (
          <EmptyState
            icon={<Bot className="ic" />}
            title={t("chat.subagent.empty")}
            description={t("chat.subagent.stepsHint")}
          />
        ) : (
          <WorkList
            items={steps}
            ended={subagent.status !== "running"}
            className="subagent-view-steps"
          />
        )}
        {subagent.output ? (
          <section className="subagent-view-result">
            <div className="subagent-view-label">{t("chat.subagent.result")}</div>
            <div className="msg-ai md">
              <MessageText text={subagent.output} />
            </div>
          </section>
        ) : null}
      </div>
    </ConversationActionsContext.Provider>
  )
}
