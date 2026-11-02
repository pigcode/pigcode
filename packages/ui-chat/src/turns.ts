/**
 * 把线程事件整理成一轮一轮的对话（参照 ZCode 的 turn render unit）：用户消息、折叠起来的工作
 * （思考、工具、过程消息、提问与子 agent）、待处理的审批、工作区之外的最终回答、改过的文件与
 * 结束状态。待办与进入计划模式不进时间线，待办在状态面板里显示。
 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { ApprovalRequest } from "./approval-card"
import {
  approvalFromEvent,
  asRecord,
  asText,
  collectAnswers,
  collectResolved,
  collectSubagents,
  collectTools,
  isParentScoped,
  questionFromEvent,
  toolFromEvent,
} from "./event-parsers"
import { fileChanges, mergeFileChanges, toolInputValue, type FileChange } from "./file-changes"
import type { QuestionRequestView } from "./question-card"
import type { SubagentCall } from "./subagent-card"
import { todoItems, type TodoItem } from "./tool-fields"
import { isHiddenTool, toolFamily } from "./tool-identity"
import type { ToolCall, ToolStatus } from "./tool-meta"
import { groupTools, type GroupKind } from "./work-groups"

/** 一轮里的一项工作。 */
export type WorkItem =
  | { kind: "message"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string; durationMs: number | null }
  | { kind: "tool"; key: string; tool: ToolCall }
  | { kind: GroupKind; key: string; tools: ToolCall[] }
  | { kind: "subagent"; key: string; subagent: SubagentCall }
  | { kind: "question"; key: string; request: QuestionRequestView; answers: string[] | undefined }

/** 一轮的状态；waiting 表示在等用户审批或回答。 */
export type TurnStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted"

/** 一轮对话。signature 在内容不变时保持不变，供渲染时跳过未变化的轮。 */
export interface Turn {
  key: string
  runId: string | null
  userText: string | null
  agentId: string | null
  status: TurnStatus
  startedAt: string | null
  endedAt: string | null
  work: WorkItem[]
  /** 还在等用户处理的审批；处理过的只体现在工具行的状态上。 */
  approvals: ApprovalRequest[]
  /** 工作区之外的最终回答；运行中或最后一项不是文字时为 null。 */
  answer: string | null
  /** 这一轮助手说过的全部文字，复制按钮用。 */
  replyText: string
  replyAt: string | null
  /** 这一轮改过的文件（按路径合并）。 */
  files: FileChange[]
  /** 这一轮最新的待办；状态面板用。 */
  plan: TodoItem[] | null
  error: string | null
  signature: string
}

/** 时间线上的一项：一轮对话、切换 agent 的分隔线，或子代理带上主会话近况的提示。 */
export type TimelineEntry =
  | { kind: "turn"; turn: Turn }
  | { kind: "switch"; key: string; agentId: string; handoff: boolean }
  | { kind: "brief"; key: string }

function emptyTurn(key: string, runId: string | null): Turn {
  return {
    key,
    runId,
    userText: null,
    agentId: null,
    status: "completed",
    startedAt: null,
    endedAt: null,
    work: [],
    approvals: [],
    answer: null,
    replyText: "",
    replyAt: null,
    files: [],
    plan: null,
    error: null,
    signature: "",
  }
}

/** 结束状态对应的事件类型。 */
const END_STATUS: Partial<Record<ThreadEvent["type"], TurnStatus>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.interrupted": "interrupted",
}

/** 这一轮是否已经结束。 */
export function isEnded(turn: Pick<Turn, "status">): boolean {
  return turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted"
}

/** 构建过程中的附加信息：消息位置与提问工具，结束时整理用。 */
interface Draft {
  texts: Array<{ text: string; at: string }>
  hasQuestionEvents: boolean
}

/**
 * 按 runId 分轮；没有 runId 的助手消息各自成一轮。正在流式输出时（streaming）文字属于最后一个
 * 未结束的轮，没有未结束的轮时补一个运行中的轮。流式文本本身不参与分轮，增量到来时不必重算。
 */
export function buildTimeline(events: readonly ThreadEvent[], streaming = false): TimelineEntry[] {
  const sorted = [...events].sort((left, right) => left.seq - right.seq)
  const tools = collectTools(sorted)
  const resolved = collectResolved(sorted)
  const answered = collectAnswers(sorted)
  const subagents = collectSubagents(sorted)
  const entries: TimelineEntry[] = []
  const turns = new Map<string, Turn>()
  const drafts = new Map<string, Draft>()
  const seenTools = new Set<string>()

  const turnFor = (event: ThreadEvent): Turn => {
    const key = event.runId ?? `seq-${event.seq}`
    let turn = turns.get(key)
    if (!turn) {
      turn = emptyTurn(key, event.runId)
      // 有 runId 的轮在收到结束事件之前都还在进行。
      if (event.runId !== null) turn.status = "running"
      turn.startedAt = event.createdAt
      turns.set(key, turn)
      drafts.set(key, { texts: [], hasQuestionEvents: false })
      entries.push({ kind: "turn", turn })
    }
    turn.signature += `|${event.seq}`
    return turn
  }

  for (const event of sorted) {
    const payload = asRecord(event.payload)
    if (event.type === "thread.updated" && event.runId === null) {
      const agentId = asText(payload?.agentId)
      if (agentId) {
        entries.push({
          kind: "switch",
          key: `switch-${event.seq}`,
          agentId,
          handoff: Boolean(asText(payload?.handoff)),
        })
      } else if (asText(payload?.handoff)) {
        entries.push({ kind: "brief", key: `brief-${event.seq}` })
      }
      continue
    }
    if (event.runId === null && event.type !== "message.completed") continue
    const turn = turnFor(event)
    const draft = drafts.get(turn.key)!
    // 子 agent 的消息、思考与工具在它自己的卡片里显示；这里只记进签名，让卡片随之刷新。
    if (isParentScoped(event.type) && asText(payload?.parentToolUseId)) continue
    switch (event.type) {
      case "run.queued":
        turn.status = "queued"
        break
      case "run.started":
        turn.status = "running"
        turn.startedAt = event.createdAt
        turn.agentId = asText(payload?.agentId) ?? turn.agentId
        turn.userText = asText(payload?.text) ?? turn.userText
        break
      case "message.completed": {
        const text = asText(payload?.text)
        if (!text) break
        if (asText(payload?.role) === "user") {
          turn.userText = text
          break
        }
        draft.texts.push({ text, at: event.createdAt })
        turn.work.push({ kind: "message", key: `msg-${event.seq}`, text })
        break
      }
      case "reasoning.completed": {
        const text = asText(payload?.text)
        if (!text?.trim()) break
        const duration = payload?.durationMs
        turn.work.push({
          kind: "reasoning",
          key: `reasoning-${event.seq}`,
          text,
          durationMs: typeof duration === "number" ? duration : null,
        })
        break
      }
      case "tool.started":
      case "tool.completed": {
        const status: ToolStatus = event.type === "tool.started" ? "running" : "completed"
        const parsed = toolFromEvent(event, status)
        if (!parsed || seenTools.has(parsed.id)) break
        seenTools.add(parsed.id)
        const tool = tools.get(parsed.id) ?? parsed
        if (toolFamily(tool.name) === "todo") {
          const items = todoItems(toolInputValue(tool))
          if (items.length > 0) turn.plan = items
        }
        if (isHiddenTool(tool.name)) break
        if (toolFamily(tool.name) === "agent" && subagents.has(tool.id)) break
        turn.work.push({ kind: "tool", key: `tool-${tool.id}`, tool })
        break
      }
      case "subagent.started": {
        const id = asText(payload?.toolCallId) ?? asText(payload?.id)
        const subagent = id ? subagents.get(id) : undefined
        if (subagent) turn.work.push({ kind: "subagent", key: `subagent-${subagent.id}`, subagent })
        break
      }
      case "plan.updated": {
        const items = todoItems(payload?.plan ?? payload?.steps ?? payload)
        if (items.length > 0) turn.plan = items
        break
      }
      case "approval.requested": {
        const request = approvalFromEvent(event)
        if (request && !resolved.has(request.id)) turn.approvals.push(request)
        if (turn.status === "running" && request && !resolved.has(request.id)) {
          turn.status = "waiting"
        }
        break
      }
      case "approval.resolved":
        if (turn.status === "waiting") turn.status = "running"
        break
      case "question.requested": {
        const request = questionFromEvent(event)
        if (!request) break
        draft.hasQuestionEvents = true
        const answers = answered.get(request.id)
        turn.work.push({ kind: "question", key: `question-${request.id}`, request, answers })
        if (turn.status === "running" && answers === undefined) turn.status = "waiting"
        break
      }
      case "question.answered":
        if (turn.status === "waiting") turn.status = "running"
        break
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
        turn.status = END_STATUS[event.type] ?? "completed"
        turn.endedAt = event.createdAt
        if (event.type === "run.failed") turn.error = asText(payload?.message) ?? ""
        break
      default:
        break
    }
  }

  for (const turn of turns.values()) {
    // 没有 runId 的消息（旧数据）本身就是一轮完整的回答。
    if (turn.runId === null && turn.status !== "running") turn.endedAt ??= turn.startedAt
  }

  const open = [...turns.values()].reverse().find((turn) => !isEnded(turn))
  if (streaming && !open) {
    const turn = emptyTurn("streaming", null)
    turn.status = "running"
    entries.push({ kind: "turn", turn })
  }

  for (const turn of turns.values()) finalizeTurn(turn, drafts.get(turn.key)!)
  return entries
}

/** 一轮结束时还在运行的工具与子 agent 记为已停止。 */
function stopUnfinished(item: WorkItem): WorkItem {
  if (item.kind === "tool" && item.tool.status === "running") {
    return { ...item, tool: { ...item.tool, status: "stopped" } }
  }
  if (item.kind === "subagent" && item.subagent.status === "running") {
    return { ...item, subagent: { ...item.subagent, status: "interrupted" } }
  }
  return item
}

/**
 * 整理一轮：结束后还在运行的工具记为已停止；最后一项若是文字，提出来作为工作区之外的回答；
 * 和提问事件重复的提问工具、结束后才失去意义的审批去掉；连续的同类工具合并；改过的文件按路径汇总。
 */
function finalizeTurn(turn: Turn, draft: Draft): void {
  const ended = isEnded(turn)
  turn.replyText = draft.texts.map((entry) => entry.text).join("\n\n")
  turn.replyAt = draft.texts.at(-1)?.at ?? null
  let work = turn.work
  if (draft.hasQuestionEvents) {
    work = work.filter(
      (item) => item.kind !== "tool" || toolFamily(item.tool.name) !== "ask-user-question",
    )
  }
  if (ended) work = work.map(stopUnfinished)
  const last = work.at(-1)
  if (ended && last?.kind === "message") {
    turn.answer = last.text
    work = work.slice(0, -1)
  }
  if (ended) turn.approvals = []
  turn.files = mergeFileChanges(
    work.flatMap((item) =>
      item.kind === "tool" && item.tool.status === "completed" ? fileChanges(item.tool) : [],
    ),
  )
  turn.work = groupTools(work, (item) => (item.kind === "tool" ? item.tool : null)) as WorkItem[]
  turn.signature += `|${turn.status}|${turn.approvals.map((request) => request.id).join(",")}`
}

/** 线程里最新的待办；没有任何待办时为 null。 */
export function latestPlan(timeline: readonly TimelineEntry[]): TodoItem[] | null {
  for (const entry of [...timeline].reverse()) {
    if (entry.kind === "turn" && entry.turn.plan) return entry.turn.plan
  }
  return null
}

/** 是否还有未处理的审批。 */
export function hasPendingApproval(events: ThreadEvent[]): boolean {
  const resolved = collectResolved(events)
  for (const event of events) {
    if (event.type !== "approval.requested") continue
    const request = approvalFromEvent(event)
    if (request && !resolved.has(request.id)) return true
  }
  return false
}
