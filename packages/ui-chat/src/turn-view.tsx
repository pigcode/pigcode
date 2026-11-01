/**
 * 一轮对话（参照 ZCode 的 ConversationTurnGroup）：右侧的用户气泡；下面是「工作中 / 已工作 N 秒」
 * 折叠头与折叠起来的工作（思考、工具、过程消息、提问与子 agent）；再下面是待处理的审批与提问、
 * 工作区之外的最终回答、改过的文件与悬停出现的操作栏。运行中、出错、被停下或没有最终回答时
 * 工作区一直展开、没有箭头；正常结束后折叠，只留最终回答。
 */
import { memo, useState } from "react"
import { AlertTriangle, ChevronRight, LoaderCircle } from "lucide-react"
import { formatDuration, useLocale } from "@pigcode/ui-primitives"
import { ApprovalCard, type ApprovalDecision } from "./approval-card"
import { elapsed, useNow } from "./duration"
import { FileSummary } from "./file-summary"
import { MessageText } from "./message-item"
import { QuestionCard } from "./question-card"
import { TurnActions } from "./turn-actions"
import { isEnded, type Turn } from "./turns"
import { UserBubble } from "./user-bubble"
import { WorkList } from "./work-list"

/** 折叠头的文字：排队、等待、工作中、已停止、已工作或已处理。 */
function useWorkLabel(turn: Turn): string {
  const { t, locale } = useLocale()
  const live = !isEnded(turn)
  const now = useNow(live && turn.status !== "queued")
  const ms = elapsed(turn.startedAt, live ? now : turn.endedAt)
  const duration = ms === null ? "" : formatDuration(ms, locale)
  if (turn.status === "queued") return t("tabs.status.queued")
  if (turn.status === "waiting") {
    const asking = turn.work.some((item) => item.kind === "question" && !item.answers)
    return t(asking ? "chat.status.waitingAnswer" : "chat.status.waitingApproval")
  }
  if (live) return t("chat.history.workingFor").replace("{duration}", duration).trim()
  if (turn.status === "interrupted") return t("chat.history.stopped")
  return ms === null
    ? t("chat.history.worked")
    : t("chat.history.workedFor").replace("{duration}", duration)
}

/** 工作区的折叠头；一直展开时没有箭头、不能点。 */
function WorkHeader({
  turn,
  open,
  canToggle,
  onToggle,
}: {
  turn: Turn
  open: boolean
  canToggle: boolean
  onToggle: () => void
}) {
  const label = useWorkLabel(turn)
  return (
    <div className="work-head" data-status={turn.status}>
      <button
        type="button"
        className="work-toggle"
        aria-expanded={canToggle ? open : undefined}
        disabled={!canToggle}
        onClick={onToggle}
      >
        <span className="work-label">{label}</span>
        {canToggle ? <ChevronRight className="ic work-chev" aria-hidden="true" /> : null}
      </button>
    </div>
  )
}

/** 一轮对话的属性；回调由消息列表做成稳定引用，未变化的轮不会重渲染。 */
export interface TurnViewProps {
  turn: Turn
  streamingText: string
  onApproval: (requestId: string, decision: ApprovalDecision) => void
  /** 回答 agent 的提问。 */
  onAnswer?: ((requestId: string, answers: string[]) => void) | undefined
  /** 运行中命令已经流出的输出；只传给正在运行的那一轮。 */
  liveOutput?: Readonly<Record<string, string>> | undefined
  /** 正在输出的思考；只传给正在运行的那一轮。 */
  liveReasoning?: string | undefined
}

function TurnViewImpl({
  turn,
  streamingText,
  liveOutput,
  liveReasoning = "",
  onApproval,
  onAnswer,
}: TurnViewProps) {
  const { t } = useLocale()
  const ended = isEnded(turn)
  const [userOpen, setUserOpen] = useState(false)
  const hasWork = turn.work.length > 0 || liveReasoning.trim().length > 0
  const forced =
    !ended ||
    turn.status === "failed" ||
    turn.status === "interrupted" ||
    (turn.answer === null && hasWork)
  const open = forced || userOpen
  const pending = ended
    ? []
    : turn.work.flatMap((item) => (item.kind === "question" && !item.answers ? [item] : []))
  return (
    <section
      className="turn"
      data-status={turn.status}
      data-turn={turn.key}
      data-user={turn.userText ? true : undefined}
    >
      {turn.userText ? <UserBubble text={turn.userText} /> : null}
      {turn.runId !== null || !ended ? (
        <WorkHeader
          turn={turn}
          open={open}
          canToggle={!forced && hasWork}
          onToggle={() => setUserOpen(!userOpen)}
        />
      ) : null}
      {hasWork && open ? (
        <WorkList
          items={turn.work}
          ended={ended}
          liveOutput={liveOutput}
          liveReasoning={liveReasoning}
        />
      ) : null}
      {turn.approvals.map((request) => (
        <ApprovalCard
          key={`approval-${request.id}`}
          request={request}
          resolved={undefined}
          onApproval={onApproval}
        />
      ))}
      {pending.map((item) => (
        <QuestionCard
          key={`ask-${item.request.id}`}
          request={item.request}
          onAnswer={onAnswer ?? (() => undefined)}
        />
      ))}
      {turn.answer ? (
        <div className="msg-ai md">
          <MessageText text={turn.answer} />
        </div>
      ) : null}
      {streamingText ? (
        <div className="msg-ai md is-streaming" aria-busy="true">
          <MessageText text={streamingText} streaming />
        </div>
      ) : null}
      {turn.status === "failed" ? (
        <div className="turn-error" role="alert">
          <AlertTriangle className="ic ic-sm" aria-hidden="true" />
          <span>{turn.error || t("chat.error")}</span>
        </div>
      ) : null}
      {turn.status === "running" ? (
        <div className="turn-loading" aria-hidden="true">
          <LoaderCircle className="ic ic-sm" />
        </div>
      ) : null}
      {ended ? <FileSummary id={turn.key} files={turn.files} /> : null}
      {ended && turn.replyText ? <TurnActions text={turn.replyText} at={turn.replyAt} /> : null}
    </section>
  )
}

/** 只在这一轮的内容、流式文本或实时输出变化时重渲染。 */
export const TurnView = memo(
  TurnViewImpl,
  (previous, next) =>
    previous.turn.signature === next.turn.signature &&
    previous.streamingText === next.streamingText &&
    previous.liveOutput === next.liveOutput &&
    previous.liveReasoning === next.liveReasoning &&
    previous.onApproval === next.onApproval &&
    previous.onAnswer === next.onAnswer,
)
