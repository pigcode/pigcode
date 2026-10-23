/**
 * 按轮渲染时间线：每轮一个用户气泡与一段助手工作；切换 agent、带上主会话近况时插一条
 * 两侧是细线的标记（参照 ZCode 的 MarkerDividerRow）。打开文件、查看改动与打开子 agent 的
 * 入口通过上下文交给各个工具行。
 */
import { useCallback, useMemo, useRef } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { ArrowLeftRight, Sparkles, Waypoints, type LucideIcon } from "lucide-react"
import { formatShortcut, useLocale } from "@pigcode/ui-primitives"
import type { ApprovalDecision } from "./approval-card"
import { ConversationActionsContext, type ConversationActions } from "./tools"
import { TurnView } from "./turn-view"
import { buildTimeline, isEnded, type TimelineEntry } from "./turns"

export { hasPendingApproval } from "./turns"

/** 空会话的标题与说明；子代理会话用它替换默认文案。 */
export interface EmptyStateText {
  title: string
  hint: string
}

/** 消息列表需要的线程事件与交互回调。 */
export interface MessageListProps {
  events: ThreadEvent[]
  /** 已经按事件算好的时间线；不提供时由列表自己计算。 */
  timeline?: readonly TimelineEntry[] | undefined
  streamingText?: string
  /** 正在输出的思考，显示在运行中那一轮的工作区末尾。 */
  liveReasoning?: string | undefined
  /** 把 agent id 换成展示名；切换分隔线使用。 */
  agentName?: (agentId: string) => string
  onApproval: (requestId: string, decision: ApprovalDecision) => void
  /** 项目目录；文件路径按它显示成相对路径。 */
  root?: string | undefined
  onOpenFile?: ((path: string) => void) | undefined
  onViewDiff?: ((path?: string) => void) | undefined
  onOpenSubagent?: ((id: string) => void) | undefined
  empty?: EmptyStateText | undefined
  /** 运行中命令已经流出的输出，按工具调用 id。 */
  liveOutput?: Readonly<Record<string, string>> | undefined
  onAnswer?: ((requestId: string, answers: string[]) => void) | undefined
}

/** 保持引用不变、调用时总是转给最新回调的包装，避免未变化的轮因回调变化而重渲染。 */
function useStable<A extends unknown[], R>(
  callback: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const ref = useRef(callback)
  ref.current = callback
  const stable = useCallback((...args: A) => ref.current!(...args), [])
  return callback ? stable : undefined
}

/** 两侧细线的标记行。 */
function MarkerDivider({
  icon: Icon,
  label,
  role,
}: {
  icon: LucideIcon
  label: string
  role: string
}) {
  return (
    <div className="marker-divider" role={role}>
      <span className="marker-line" aria-hidden="true" />
      <span className="marker-label">
        <Icon className="ic ic-xs" aria-hidden="true" />
        <span>{label}</span>
      </span>
      <span className="marker-line" aria-hidden="true" />
    </div>
  )
}

function EmptyState({ empty }: { empty: EmptyStateText | undefined }) {
  const { t } = useLocale()
  return (
    <div className="chat-empty">
      <span className="empty-mark" aria-hidden="true">
        <Sparkles className="ic" />
      </span>
      <h2>{empty?.title ?? t("chat.empty.title")}</h2>
      <p>{empty?.hint ?? t("chat.empty.hint")}</p>
      {empty ? null : (
        <div className="empty-hints">
          <span>
            <kbd>{formatShortcut("Mod+k")}</kbd>
            {t("chat.empty.command")}
          </span>
          <span>
            <kbd>{formatShortcut("Mod+n")}</kbd>
            {t("chat.empty.newThread")}
          </span>
        </div>
      )}
    </div>
  )
}

/** 渲染整条时间线，流式文本、思考与命令输出放在正在运行的那一轮里。 */
export function MessageList({
  events,
  timeline: given,
  streamingText = "",
  liveReasoning = "",
  agentName,
  onApproval,
  root,
  onOpenFile,
  onViewDiff,
  onOpenSubagent,
  empty,
  liveOutput,
  onAnswer,
}: MessageListProps) {
  const { t } = useLocale()
  const streaming = streamingText.length > 0
  const computed = useMemo(
    () => (given ? null : buildTimeline(events, streaming)),
    [given, events, streaming],
  )
  const timeline = given ?? computed ?? []
  const approve = useStable(onApproval)!
  const answer = useStable(onAnswer)
  const openFile = useStable(onOpenFile)
  const viewDiff = useStable(onViewDiff)
  const openSubagent = useStable(onOpenSubagent)
  const actions = useMemo<ConversationActions>(
    () => ({ root, onOpenFile: openFile, onViewDiff: viewDiff, onOpenSubagent: openSubagent }),
    [root, openFile, viewDiff, openSubagent],
  )
  // 流式文本、思考与命令输出都属于最后一个还没结束的轮；其余轮拿不到它们，不会因此重渲染。
  const openKey = useMemo(() => {
    for (const entry of [...timeline].reverse()) {
      if (entry.kind === "turn" && !isEnded(entry.turn)) return entry.turn.key
    }
    return null
  }, [timeline])

  if (!timeline.some((entry) => entry.kind !== "brief")) {
    return (
      <div className="msgs">
        <EmptyState empty={empty} />
        {timeline.length > 0 ? (
          <MarkerDivider icon={Waypoints} label={t("chat.subagent.brief")} role="note" />
        ) : null}
      </div>
    )
  }
  return (
    <ConversationActionsContext.Provider value={actions}>
      <div className="msgs">
        {timeline.map((entry) => {
          if (entry.kind === "brief") {
            return (
              <MarkerDivider
                key={entry.key}
                icon={Waypoints}
                label={t("chat.subagent.brief")}
                role="note"
              />
            )
          }
          if (entry.kind === "switch") {
            const name = agentName?.(entry.agentId) ?? entry.agentId
            const label = `${t("chat.switch.to").replace("{agent}", name)}${
              entry.handoff ? ` · ${t("chat.switch.handoff")}` : ""
            }`
            return (
              <MarkerDivider key={entry.key} icon={ArrowLeftRight} label={label} role="separator" />
            )
          }
          const live = entry.turn.key === openKey
          return (
            <TurnView
              key={entry.turn.key}
              turn={entry.turn}
              streamingText={live && streaming ? streamingText : ""}
              liveOutput={live ? liveOutput : undefined}
              liveReasoning={live ? liveReasoning : ""}
              onApproval={approve}
              onAnswer={answer}
            />
          )
        })}
      </div>
    </ConversationActionsContext.Provider>
  )
}
