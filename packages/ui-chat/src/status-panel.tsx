/**
 * 会话状态面板（参照 ZCode 的 ConversationStatusPanel）：浮在会话区右上角。收起时是一枚胶囊，
 * 显示当前待办、最后完成的一项或「进程 3/5」，没有待办时显示后台在跑的数量；展开后是 320px 的
 * 面板，分区列出待办与运行中的命令、子 agent。没有待办也没有在跑的任务时不显示。
 */
import { useState, type ReactNode } from "react"
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  Maximize2,
  Minimize2,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { elapsed, formatDuration, useNow } from "./duration"
import { toolFamily } from "./tool-identity"
import { commandText } from "./tool-meta"
import type { TodoItem } from "./tool-fields"
import { isEnded, latestPlan, type TimelineEntry } from "./turns"

/** 运行中的一项后台工作：命令或子 agent。 */
export interface RunningWork {
  id: string
  kind: "command" | "agent"
  title: string
  startedAt: string | null
}

/** 最后一个还没结束的轮里正在运行的命令与子 agent。 */
export function runningWorks(timeline: readonly TimelineEntry[]): RunningWork[] {
  const open = [...timeline]
    .reverse()
    .find((entry) => entry.kind === "turn" && !isEnded(entry.turn))
  if (!open || open.kind !== "turn") return []
  const works: RunningWork[] = []
  for (const item of open.turn.work) {
    if (item.kind === "subagent" && item.subagent.status === "running") {
      works.push({
        id: item.subagent.id,
        kind: "agent",
        title: item.subagent.description ?? item.subagent.name,
        startedAt: null,
      })
      continue
    }
    const tools = item.kind === "tool" ? [item.tool] : item.kind === "commands" ? item.tools : []
    for (const tool of tools) {
      if (tool.status !== "running" || toolFamily(tool.name) !== "shell") continue
      works.push({
        id: tool.id,
        kind: "command",
        title: commandText(tool.input) ?? tool.name,
        startedAt: tool.startedAt ?? null,
      })
    }
  }
  return works
}

function PlanIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return <CheckCircle2 className="ic ic-xs status-plan-icon is-done" aria-hidden="true" />
  }
  if (status === "in-progress") {
    return <ArrowRight className="ic ic-xs status-plan-icon is-current" aria-hidden="true" />
  }
  return <Circle className="ic ic-xs status-plan-icon" aria-hidden="true" />
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string
  trailing?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="status-section">
      <div className="status-section-head">
        <button
          type="button"
          className="status-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span>{title}</span>
          <Chevron className="ic ic-xs" aria-hidden="true" />
        </button>
        {trailing ? <span className="status-section-trailing">{trailing}</span> : null}
      </div>
      {open ? children : null}
    </section>
  )
}

function RunningRow({ work }: { work: RunningWork }) {
  const { locale } = useLocale()
  const now = useNow(work.startedAt !== null)
  const ms = elapsed(work.startedAt, now)
  const Icon = work.kind === "agent" ? Bot : SquareTerminal
  return (
    <li className="status-running-row">
      <Icon className="ic ic-sm" aria-hidden="true" />
      <span className="status-running-title">{work.title}</span>
      {ms === null ? null : (
        <span className="status-running-time">{formatDuration(ms, locale)}</span>
      )}
    </li>
  )
}

/** 胶囊里的一行摘要。 */
function Summary({ plan, running }: { plan: TodoItem[] | null; running: RunningWork[] }) {
  const { t } = useLocale()
  const metric = (icon: LucideIcon, iconClass: string, text: string, extra?: string) => {
    const Icon = icon
    return (
      <span className="status-metric">
        <span className="status-metric-icon">
          <Icon className={`ic ic-sm ${iconClass}`} aria-hidden="true" />
          <Maximize2 className="ic ic-sm status-metric-expand" aria-hidden="true" />
        </span>
        <span className="truncate">{text}</span>
        {extra ? <span className="status-metric-extra">{extra}</span> : null}
      </span>
    )
  }
  const current =
    plan?.find((item) => item.status === "in-progress") ??
    plan?.find((item) => item.status === "pending")
  if (current) return metric(ArrowRight, "", current.text)
  const done = plan ? [...plan].reverse().find((item) => item.status === "completed") : undefined
  if (done) return metric(CheckCircle2, "is-success", done.text)
  if (plan) {
    const completed = plan.filter((item) => item.status === "completed").length
    return metric(
      ListChecks,
      "is-subtle",
      t("chat.statusPanel.todo"),
      `${completed}/${plan.length}`,
    )
  }
  const agents = running.some((work) => work.kind === "agent")
  const commands = running.some((work) => work.kind === "command")
  return metric(
    agents && commands ? Activity : agents ? Bot : SquareTerminal,
    "",
    t(agents ? "chat.statusPanel.runningAgents" : "chat.summaryPanel.runningCount").replace(
      "{count}",
      String(running.length),
    ),
  )
}

/** 渲染状态面板。 */
export function StatusPanel({ timeline }: { timeline: readonly TimelineEntry[] }) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const plan = latestPlan(timeline)
  const running = runningWorks(timeline)
  if (!plan && running.length === 0) return null
  const completed = plan?.filter((item) => item.status === "completed").length ?? 0
  return (
    <div className="status-anchor">
      <aside
        className="status-panel"
        aria-label={t("chat.summaryPanel.title")}
        data-state={expanded ? "expanded" : "collapsed"}
      >
        {expanded ? (
          <>
            <button
              type="button"
              className="status-panel-minimize"
              aria-label={t("chat.summaryPanel.showMini")}
              title={t("chat.summaryPanel.showMini")}
              onClick={() => setExpanded(false)}
            >
              <Minimize2 className="ic ic-xs" aria-hidden="true" />
            </button>
            <div className="status-panel-body">
              {plan ? (
                <Section
                  title={t("chat.statusPanel.todo")}
                  trailing={
                    <span data-done={completed >= plan.length || undefined}>
                      {completed}/{plan.length}
                    </span>
                  }
                >
                  <ul className="status-plan">
                    {plan.map((item, index) => (
                      <li key={index} className="status-plan-row" data-status={item.status}>
                        <PlanIcon status={item.status} />
                        <span className="status-plan-text" title={item.text}>
                          {item.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
              {running.length > 0 ? (
                <Section
                  title={t("chat.summaryPanel.runningTasks")}
                  trailing={String(running.length)}
                >
                  <ul className="status-running">
                    {running.map((work) => (
                      <RunningRow key={work.id} work={work} />
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          </>
        ) : (
          <button
            type="button"
            className="status-capsule"
            aria-label={t("chat.summaryPanel.showPanel")}
            title={t("chat.summaryPanel.showPanel")}
            onClick={() => setExpanded(true)}
          >
            <Summary plan={plan} running={running} />
          </button>
        )}
      </aside>
    </div>
  )
}
