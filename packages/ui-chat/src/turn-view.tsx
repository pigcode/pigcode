/**
 * 一轮对话（参照 ZCode 3.18 的 ConversationTurnGroup）：右侧的用户气泡；下面是工作（思考、工具、过程
 * 消息、提问与子 agent）；再下面是待处理的审批与提问、工作区之外的最终回答、改过的文件与操作栏。
 * 运行中没有折叠头，工作一直展开，末尾一行「工作中」和计时；结束后才出现「用时 N 秒」折叠头，
 * 正常结束时把工作收起来，只留最终回答；出错、被停下或没有最终回答时工作照样展开。
 */
import { memo, useState } from "react"
import { AlertTriangle, ChevronRight, Info } from "lucide-react"
import { DotMatrix, formatDuration, isMessageKey, useLocale } from "@pigcode/ui-primitives"
import { ApprovalCard, type ApprovalDecision } from "./approval-card"
import { elapsed, useNow } from "./duration"
import type { SessionNotice } from "./event-parsers"
import { FileSummary } from "./file-summary"
import { MessageText } from "./message-item"
import { QuestionCard } from "./question-card"
import { TurnActions } from "./turn-actions"
import { isEnded, type Turn } from "./turns"
import { UserBubble } from "./user-bubble"
import { WorkList } from "./work-list"

/** 结束后折叠头的文字：已停止、用时 N 秒，或者没有开始时间时的已处理。 */
function useWorkLabel(turn: Turn): string {
  const { t, locale } = useLocale()
  const ms = elapsed(turn.startedAt, turn.endedAt)
  if (turn.status === "interrupted") return t("chat.history.stopped")
  return ms === null
    ? t("chat.history.worked")
    : t("chat.history.workedFor").replace("{duration}", formatDuration(ms, locale))
}

/**
 * 运行中接在这一轮末尾的一行（ZCode 的 ChatLoading）：点阵、扫光的「工作中」和已经用了多久；
 * 排队时写「排队中」、不计时。等用户批准或回答时不显示，由审批与提问卡片说明在等什么。
 */
function TurnLoading({ turn }: { turn: Turn }) {
  const { t, locale } = useLocale()
  const queued = turn.status === "queued"
  const now = useNow(!queued)
  const ms = queued ? null : elapsed(turn.startedAt, now)
  const label = queued ? t("tabs.status.queued") : t("chat.loading.working")
  return (
    <div className="turn-loading" role="status" aria-label={label}>
      <span className="turn-loading-icon" aria-hidden="true">
        <DotMatrix />
      </span>
      <span className={queued ? "turn-loading-label" : "turn-loading-label tool-shimmer"}>
        {label}
      </span>
      {ms === null ? null : (
        <span className="turn-loading-time" aria-hidden="true">
          {formatDuration(ms, locale)}
        </span>
      )}
    </div>
  )
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

/** 一条会话提示：还能继续，但有东西没接上。放在工作区外面，收起时也看得见。 */
function NoticeLine({ notice }: { notice: SessionNotice }) {
  const { t } = useLocale()
  // Agent 只给稳定的键（mcp.bridge.failed），界面从 chat.notice.<键> 取文案；
  // 版本不一致时语言包里可能没有这条，此时原样显示键名，总比什么都不说好。
  const message = `chat.notice.${notice.key}`
  const template = isMessageKey(message) ? t(message) : notice.key
  const text = Object.entries(notice.params).reduce(
    (line, [name, value]) => line.replaceAll(`{${name}}`, value),
    template,
  )
  return (
    <div className="turn-notice" data-level={notice.level} role="status">
      <Info className="ic ic-sm" aria-hidden="true" />
      <span>{text}</span>
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
      {turn.userText ? (
        <UserBubble text={turn.userText} at={turn.userAt} references={turn.userReferences} />
      ) : null}
      {ended && turn.runId !== null ? (
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
          growing={turn.status === "running" && !streamingText}
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
      {turn.notices.map((notice) => (
        <NoticeLine key={notice.id} notice={notice} />
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
      {turn.status === "running" || turn.status === "queued" ? <TurnLoading turn={turn} /> : null}
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
