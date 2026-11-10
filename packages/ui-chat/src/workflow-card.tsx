/**
 * 工作流卡片（Claude Code 的 Workflow 工具，Ultracode 打开时会用）：主 agent 写一段脚本，在后台按阶段派出
 * 一组 agent。一行摘要是「工作流 · 名字 · 当前阶段 · 完成数」，后面一排小点是每个 agent 的状态；
 * 运行中第一次出现时自动展开。展开后按阶段列出 agent：运行中显示它在做的事，完成后显示结论、耗时与 token，
 * 点开一个 agent 看它的任务和完整结论；最下面可以看工作流脚本。
 *
 * 数据是 driver 发来的 workflow.updated 快照，按 toolCallId 合并，后到的字段覆盖先到的。
 */
import { memo, useState } from "react"
import type {
  ThreadEvent,
  WorkflowAgent,
  WorkflowSnapshot,
  WorkflowStatus,
} from "@pigcode/contracts"
import { Check, ChevronRight, Circle, Square, Workflow, X } from "lucide-react"
import { StatusDot, formatDuration, useLocale, type Locale } from "@pigcode/ui-primitives"
import { asRecord, asText } from "./event-parsers"
import { MessageText } from "./message-item"
import { ToolRow } from "./tool-row"

/** 时间线里一个工作流需要的数据。 */
export type WorkflowCall = WorkflowSnapshot & {
  /** 派生它的 run。 */
  runId: string | null
}

const STATUSES = new Set<WorkflowStatus>(["running", "completed", "failed", "stopped"])

/** 按 toolCallId 合并 workflow.updated 快照；格式不对的快照跳过。 */
export function collectWorkflows(events: readonly ThreadEvent[]): Map<string, WorkflowCall> {
  const workflows = new Map<string, WorkflowCall>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type !== "workflow.updated") continue
    const payload = asRecord(event.payload)
    const id = asText(payload?.toolCallId)
    if (!payload || !id) continue
    const status = STATUSES.has(payload.status as WorkflowStatus)
      ? (payload.status as WorkflowStatus)
      : undefined
    const previous = workflows.get(id)
    const next = {
      ...previous,
      ...(payload as Partial<WorkflowSnapshot>),
      toolCallId: id,
      status: status ?? previous?.status ?? "running",
      phases: Array.isArray(payload.phases) ? payload.phases : (previous?.phases ?? []),
      agents: Array.isArray(payload.agents) ? payload.agents : (previous?.agents ?? []),
      runId: event.runId,
    } as WorkflowCall
    workflows.set(id, next)
  }
  return workflows
}

/** 显示用的 agent 状态：工作流已经结束时，还没完成的 agent 记为已停止。 */
type ShownState = WorkflowAgent["state"] | "stopped"

function shownState(agent: WorkflowAgent, workflow: WorkflowStatus): ShownState {
  if (workflow !== "running" && (agent.state === "running" || agent.state === "queued")) {
    return "stopped"
  }
  return agent.state
}

/** 「64k tokens」这样的短写法。 */
function shortCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`.replace(".0k", "k")
  return `${Math.round(value / 100_000) / 10}M`.replace(".0M", "M")
}

/** 耗时与 token：「21 秒 · 32k tokens」。 */
function usageText(
  usage: { durationMs?: number | undefined; tokens?: number | undefined },
  locale: Locale,
): string | null {
  const parts = [
    usage.durationMs ? formatDuration(usage.durationMs, locale) : null,
    usage.tokens ? `${shortCount(usage.tokens)} tokens` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** 一行预览里的行内代码：`x` 画成代码样式，其余原样；只有这一种标记，不跑完整的 Markdown。 */
function InlinePreview({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/)
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="workflow-inline-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}

/** 一个 agent 的状态图标：排队空心圈、运行中点阵、完成对勾、失败叉、停止方块。 */
function AgentIcon({ state }: { state: ShownState }) {
  if (state === "running") return <StatusDot tone="running" className="workflow-agent-dot" />
  const Icon =
    state === "done" ? Check : state === "failed" ? X : state === "stopped" ? Square : Circle
  return <Icon className="ic ic-xs workflow-agent-icon" aria-hidden="true" />
}

/** 一个 agent：一行状态、标签、在做的事或结论、耗时；点开看任务与完整结论。 */
function AgentLine({ agent, workflow }: { agent: WorkflowAgent; workflow: WorkflowStatus }) {
  const { t, locale } = useLocale()
  const [open, setOpen] = useState(false)
  const state = shownState(agent, workflow)
  const detail = state === "running" ? agent.activity : agent.result
  const usage = state === "running" ? null : usageText(agent, locale)
  const expandable = Boolean(agent.prompt || agent.result)
  return (
    <li className="workflow-agent" data-state={state} data-open={open || undefined}>
      <button
        type="button"
        className="workflow-agent-head"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
      >
        <span className="workflow-agent-status" title={t(`chat.workflow.state.${state}`)}>
          <AgentIcon state={state} />
          <span className="sr-only">{t(`chat.workflow.state.${state}`)}</span>
        </span>
        <span className="workflow-agent-label">{agent.label}</span>
        {detail ? (
          <span
            className={
              state === "running" ? "workflow-agent-detail tool-shimmer" : "workflow-agent-detail"
            }
          >
            <InlinePreview text={detail} />
          </span>
        ) : (
          <span className="workflow-agent-detail" />
        )}
        {usage ? <span className="workflow-agent-usage">{usage}</span> : null}
        {expandable ? (
          <ChevronRight className="ic ic-xs workflow-agent-chev" aria-hidden="true" />
        ) : null}
      </button>
      {open ? (
        <div className="workflow-agent-body">
          {agent.prompt ? (
            <div className="subagent-section">
              <span className="tool-card-label">{t("chat.workflow.task")}</span>
              <div className="workflow-agent-text md">
                <MessageText text={agent.prompt} />
              </div>
            </div>
          ) : null}
          {agent.result ? (
            <div className="subagent-section">
              <span className="tool-card-label">{t("chat.workflow.result")}</span>
              <div className="workflow-agent-text md">
                <MessageText text={agent.result} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** 按阶段分组；没有阶段的 agent 放在最后一组。 */
function phaseGroups(workflow: WorkflowCall): { title: string | null; agents: WorkflowAgent[] }[] {
  const groups = workflow.phases.map(
    (phase): { title: string | null; agents: WorkflowAgent[] } => ({
      title: phase.title,
      agents: workflow.agents.filter((agent) => agent.phase === phase.title),
    }),
  )
  const known = new Set(workflow.phases.map((phase) => phase.title))
  const rest = workflow.agents.filter((agent) => !agent.phase || !known.has(agent.phase))
  if (rest.length > 0) groups.push({ title: groups.length > 0 ? "" : null, agents: rest })
  return groups.filter((group) => group.agents.length > 0 || group.title)
}

/** 展开后的内容：说明与总用量，按阶段的 agent，脚本。 */
function WorkflowBody({ workflow }: { workflow: WorkflowCall }) {
  const { t, locale } = useLocale()
  const [script, setScript] = useState(false)
  const usage = workflow.usage ? usageText(workflow.usage, locale) : null
  const groups = phaseGroups(workflow)
  return (
    <div className="tool-card workflow-card">
      {workflow.description || usage ? (
        <div className="workflow-overview">
          {workflow.description ? (
            <span className="workflow-description">{workflow.description}</span>
          ) : null}
          {usage ? <span className="workflow-usage">{usage}</span> : null}
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div className="workflow-empty">
          {workflow.status === "running" ? <StatusDot tone="running" /> : null}
          <span>
            {workflow.status === "running"
              ? t("chat.workflow.preparing")
              : t("chat.workflow.noAgents")}
          </span>
        </div>
      ) : (
        groups.map((group, index) => {
          const done = group.agents.filter((agent) => agent.state === "done").length
          return (
            <section key={`${group.title ?? "agents"}-${index}`} className="workflow-phase">
              {group.title !== null ? (
                <header className="workflow-phase-head">
                  <span className="workflow-phase-index">{index + 1}</span>
                  <span className="workflow-phase-title">
                    {group.title || t("chat.workflow.otherPhase")}
                  </span>
                  <span className="workflow-phase-count">
                    {done}/{group.agents.length}
                  </span>
                </header>
              ) : null}
              <ul className="workflow-agents">
                {group.agents.map((agent) => (
                  <AgentLine key={agent.index} agent={agent} workflow={workflow.status} />
                ))}
              </ul>
            </section>
          )
        })
      )}
      {workflow.status === "failed" && workflow.summary ? (
        <div className="workflow-failure">{workflow.summary}</div>
      ) : null}
      {workflow.script ? (
        <div className="workflow-script">
          <button
            type="button"
            className="workflow-script-toggle"
            aria-expanded={script}
            onClick={() => setScript(!script)}
          >
            <ChevronRight className="ic ic-xs" aria-hidden="true" />
            {t("chat.workflow.script")}
          </button>
          {script ? <pre className="workflow-script-code">{workflow.script}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

/** 一排小点：每个 agent 一个，颜色是它的状态。超过 12 个只画前 12 个。 */
function AgentPips({ workflow }: { workflow: WorkflowCall }) {
  if (workflow.agents.length < 2) return null
  return (
    <span className="workflow-pips" aria-hidden="true">
      {workflow.agents.slice(0, 12).map((agent) => (
        <span
          key={agent.index}
          className="workflow-pip"
          data-state={shownState(agent, workflow.status)}
        />
      ))}
    </span>
  )
}

/** 渲染一个工作流。 */
export const WorkflowRow = memo(function WorkflowRow({ workflow }: { workflow: WorkflowCall }) {
  const { t } = useLocale()
  const running = workflow.status === "running"
  const total = workflow.agents.length
  const done = workflow.agents.filter((agent) => agent.state === "done").length
  const phase =
    workflow.agents.find((agent) => agent.state === "running")?.phase ??
    (workflow.phases.length > 1 ? workflow.phases.at(-1)?.title : undefined)
  const progress =
    total > 0
      ? t("chat.workflow.progress")
          .replace("{done}", String(done))
          .replace("{total}", String(total))
      : null
  const primary = running
    ? [phase, progress].filter(Boolean).join(" · ") || t("chat.workflow.preparing")
    : (workflow.description ?? progress ?? "")
  const status =
    workflow.status === "failed"
      ? { label: t("chat.toolCall.status.failed"), tooltip: workflow.summary }
      : workflow.status === "stopped"
        ? { label: t("chat.toolCall.status.stopped") }
        : null
  return (
    <ToolRow
      id={`workflow-${workflow.toolCallId}`}
      icon={Workflow}
      kind={t("chat.workflow.label")}
      running={running}
      kindDetail={
        workflow.name ? <span className="workflow-name">{workflow.name}</span> : undefined
      }
      separator={Boolean(primary)}
      primary={primary ? <span className="truncate">{primary}</span> : undefined}
      secondary={<AgentPips workflow={workflow} />}
      status={status}
      title={workflow.description}
      autoOpen={running}
      className="workflow-row"
      dataStatus={workflow.status}
    >
      {() => <WorkflowBody workflow={workflow} />}
    </ToolRow>
  )
})
