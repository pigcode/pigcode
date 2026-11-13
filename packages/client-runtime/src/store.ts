import { threadPatchFromEvent } from "./thread-patch"
/** Renderer 的应用状态；组件通过 useSyncExternalStore 订阅。 */
import { useSyncExternalStore } from "react"
import type { Project, AgentFeatures, Thread, ThreadEvent } from "@pigcode/contracts"
import type { ConnectionStatus } from "./connection"

/** 单个线程在 Renderer 中的运行状态。 */
export type ThreadViewStatus =
  "idle" | "queued" | "running" | "waiting-approval" | "completed" | "failed" | "interrupted"

/** 每个打开线程独立维护的事件、流式文本与运行状态。 */
export interface ThreadViewState {
  events: ThreadEvent[]
  streamingText: string
  /** 运行中命令已经流出的输出，按工具调用 id；命令结束后由完整输出取代。 */
  liveOutput: Readonly<Record<string, string>>
  /** 正在流出的思考过程；思考结束（reasoning.completed）后由持久事件取代。 */
  liveReasoning: string
  status: ThreadViewStatus
  pendingApprovals: number
  lastError: string | null
  /** 订阅回放已经到达；在这之前 events 为空不代表会话里还没有消息。 */
  loaded: boolean
}

/** Renderer 全局状态快照。 */
export interface AppState {
  status: ConnectionStatus
  projects: Project[]
  threads: Thread[]
  activeProjectId: string | null
  activeThreadId: string | null
  /** 活动线程的事件镜像；多线程状态以 threadStates 为准。 */
  events: ThreadEvent[]
  /** 活动线程的流式文本镜像；多线程状态以 threadStates 为准。 */
  streamingText: string
  error: string | null
  /** 首次连接后是否发生过 Host 重连；供界面显示重连提示。 */
  reconnected: boolean
  /** 当前线程 agent 的 Agent 功能；尚未加载时为 null。 */
  agentFeatures: AgentFeatures | null
  /** 插件启停后递增，通知依赖 agent 列表的界面重新拉取。 */
  agentRevision: number
  /** 按 threadId 索引的线程视图状态。 */
  threadStates: Record<string, ThreadViewState>
  /** 当前以 tab 打开并订阅的线程顺序。 */
  openThreadIds: string[]
}

/** 线程事件的默认视图状态。 */
function emptyThreadState(): ThreadViewState {
  return {
    events: [],
    streamingText: "",
    liveOutput: {},
    liveReasoning: "",
    status: "idle",
    pendingApprovals: 0,
    lastError: null,
    loaded: false,
  }
}

const NO_OUTPUT: Readonly<Record<string, string>> = {}

/** 命令结束或 run 结束后丢掉对应的实时输出。 */
function liveOutputAfter(
  previous: Readonly<Record<string, string>>,
  event: ThreadEvent,
): Readonly<Record<string, string>> {
  if (RUN_END_EVENTS.has(event.type)) return NO_OUTPUT
  if (event.type !== "tool.completed") return previous
  const payload = event.payload as { toolCallId?: unknown; id?: unknown } | null
  const id = typeof payload?.toolCallId === "string" ? payload.toolCallId : payload?.id
  if (typeof id !== "string" || !(id in previous)) return previous
  const next = { ...previous }
  delete next[id]
  return next
}

/** 事件类型到线程状态的映射；未知事件保持原状态。 */
const STATUS_AFTER_EVENT: Record<string, ThreadViewStatus> = {
  "run.queued": "queued",
  "run.started": "running",
  "approval.requested": "waiting-approval",
  "approval.resolved": "running",
  // agent 的提问和审批一样要等用户处理。
  "question.requested": "waiting-approval",
  "question.answered": "running",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.interrupted": "interrupted",
}

/** 进入终态后，迟到的审批事件不能再把状态改回运行中。 */
const TERMINAL_STATUSES = new Set<ThreadViewStatus>(["completed", "failed", "interrupted"])

/** run 的终态事件；之后不会再有属于这个 run 的增量。 */
const RUN_END_EVENTS = new Set<ThreadEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.interrupted",
])

/** 子 agent 的完成消息带有 parentToolUseId，不能清空主线程的流式文本。 */
function isSubagentMessage(event: ThreadEvent): boolean {
  if (typeof event.payload !== "object" || event.payload === null) return false
  const parent = (event.payload as { parentToolUseId?: unknown }).parentToolUseId
  return typeof parent === "string" && parent.length > 0
}

/** 权限模式的合法值；thread.updated 里的未知值忽略。 */

/** 从事件 payload 中提取可展示的错误文本。 */
function errorFromPayload(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "message" in payload) {
    const message = (payload as { message?: unknown }).message
    return typeof message === "string" ? message : null
  }
  return null
}

/** 应用一条事件后的审批计数。 */
function pendingApprovalsAfter(previous: ThreadViewState, event: ThreadEvent): number {
  if (event.type === "approval.requested") return previous.pendingApprovals + 1
  if (event.type === "approval.resolved") return Math.max(0, previous.pendingApprovals - 1)
  return previous.pendingApprovals
}

const initialState: AppState = {
  status: "connecting",
  projects: [],
  threads: [],
  activeProjectId: null,
  activeThreadId: null,
  events: [],
  streamingText: "",
  error: null,
  reconnected: false,
  agentFeatures: null,
  agentRevision: 0,
  threadStates: {},
  openThreadIds: [],
}

/** 应用一条事件后的线程状态（不含事件数组本身）；endsStream 表示这条事件结束了流式文本。 */
function applyEvent(
  previous: ThreadViewState,
  event: ThreadEvent,
): { state: ThreadViewState; endsStream: boolean } {
  const mapped = STATUS_AFTER_EVENT[event.type]
  const late =
    (event.type === "approval.resolved" || event.type === "question.answered") &&
    TERMINAL_STATUSES.has(previous.status)
  const status = mapped && !late ? mapped : previous.status
  // 主线程的完成消息或 run 终态都会结束流式文本；中断时 Host 已把半截回复落成消息。
  const endsStream =
    (event.type === "message.completed" && !isSubagentMessage(event)) ||
    RUN_END_EVENTS.has(event.type)
  // 思考落成事件、开始回答或调用工具后，实时的思考文字都已经有了持久的去处。
  const endsReasoning =
    endsStream ||
    ((event.type === "reasoning.completed" || event.type === "tool.started") &&
      !isSubagentMessage(event))
  return {
    endsStream,
    state: {
      ...previous,
      streamingText: endsStream ? "" : previous.streamingText,
      liveOutput: liveOutputAfter(previous.liveOutput, event),
      liveReasoning: endsReasoning ? "" : previous.liveReasoning,
      status,
      pendingApprovals: pendingApprovalsAfter(previous, event),
      lastError:
        event.type === "run.failed"
          ? (errorFromPayload(event.payload) ?? previous.lastError)
          : previous.lastError,
    },
  }
}

/** 下一帧执行；没有 requestAnimationFrame 的环境（测试、Node）退回 16ms 定时器。 */
function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback())
  else setTimeout(callback, 16)
}

/** 不可变状态容器；每次变更都替换快照并通知订阅者。 */
export class AppStore {
  private state: AppState = initialState
  private readonly listeners = new Set<() => void>()
  private readonly pendingDeltas = new Map<string, string>()
  private readonly pendingOutput = new Map<string, Map<string, string>>()
  private readonly pendingReasoning = new Map<string, string>()
  private flushScheduled = false
  private readonly schedule: (callback: () => void) => void

  /** schedule 决定排队的流式文本何时写入；默认下一帧。 */
  constructor(options: { schedule?: (callback: () => void) => void } = {}) {
    this.schedule = options.schedule ?? nextFrame
  }

  getSnapshot = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  /** 打开线程：初始化独立状态并加入打开列表；loaded 给刚建好、没有历史要回放的会话。 */
  openThread(threadId: string, options: { loaded?: boolean } = {}): void {
    const threadStates = { ...this.state.threadStates }
    if (!threadStates[threadId]) threadStates[threadId] = { ...emptyThreadState(), ...options }
    const openThreadIds = this.state.openThreadIds.includes(threadId)
      ? this.state.openThreadIds
      : [...this.state.openThreadIds, threadId]
    this.state = { ...this.state, threadStates, openThreadIds }
    this.emit()
  }

  /** 关闭线程：删除状态；若关闭的是活动线程，则激活相邻线程。 */
  closeThread(threadId: string): void {
    this.flushDeltas()
    const index = this.state.openThreadIds.indexOf(threadId)
    const threadStates = { ...this.state.threadStates }
    delete threadStates[threadId]
    const openThreadIds = this.state.openThreadIds.filter((id) => id !== threadId)

    let activeThreadId = this.state.activeThreadId
    if (activeThreadId === threadId) {
      const nextIndex = Math.min(Math.max(index, 0), openThreadIds.length - 1)
      activeThreadId = openThreadIds[nextIndex] ?? null
    }
    this.state = {
      ...this.state,
      threadStates,
      openThreadIds,
      activeThreadId,
      events: this.eventsFor(threadStates, activeThreadId),
      streamingText: this.streamingFor(threadStates, activeThreadId),
    }
    this.emit()
  }

  /** 切换活动线程，并同步活动镜像；null 表示没有活动线程（新会话草稿）。 */
  setActiveThread(threadId: string | null): void {
    this.flushDeltas()
    this.state = {
      ...this.state,
      activeThreadId: threadId,
      events: this.eventsFor(this.state.threadStates, threadId),
      streamingText: this.streamingFor(this.state.threadStates, threadId),
    }
    this.emit()
  }

  /** 直接设置线程状态；供命令结果或本地交互使用。 */
  setThreadStatus(threadId: string, status: ThreadViewStatus): void {
    const previous = this.state.threadStates[threadId] ?? emptyThreadState()
    this.writeThreadState(threadId, { ...previous, status })
  }

  /** 设置线程错误文本；null 表示清除。 */
  setThreadError(threadId: string, lastError: string | null): void {
    const previous = this.state.threadStates[threadId] ?? emptyThreadState()
    this.writeThreadState(threadId, { ...previous, lastError })
  }

  /** 按 threadId 写入事件，并在活动线程时同步旧的顶层镜像。 */
  addEvent(event: ThreadEvent): void {
    this.addEvents([event])
  }

  /**
   * 批量写入事件：订阅回放一次给出整段历史，逐条写入会把事件数组复制 n 次、通知 n 次。
   * 这里每个线程只复制一次数组，所有线程处理完再通知一次。已有的 seq 跳过。
   * replayOf 是这批事件回放的线程（回放可能为空），写完记下它的历史已经读到。
   */
  addEvents(events: readonly ThreadEvent[], replayOf?: string): void {
    const firstReplay = replayOf !== undefined && !this.state.threadStates[replayOf]?.loaded
    if (events.length === 0 && !firstReplay) return
    this.flushDeltas()
    const byThread = new Map<string, ThreadEvent[]>()
    for (const event of events) {
      const list = byThread.get(event.threadId)
      if (list) list.push(event)
      else byThread.set(event.threadId, [event])
    }
    const threadStates = { ...this.state.threadStates }
    let threads = this.state.threads
    let mirroredEvents = this.state.events
    let mirroredStream = this.state.streamingText
    for (const [threadId, incoming] of byThread) {
      let state = threadStates[threadId] ?? emptyThreadState()
      const list = state.events.slice()
      let lastSeq = list.at(-1)?.seq ?? -1
      let known: Set<number> | null = null
      let endsStream = false
      let added = 0
      for (const event of incoming) {
        // 事件按 seq 递增到达；只有回退的 seq 才需要查重。
        if (event.seq <= lastSeq) {
          known ??= new Set(list.map((item) => item.seq))
          if (known.has(event.seq)) continue
          known.add(event.seq)
        } else {
          lastSeq = event.seq
        }
        list.push(event)
        added += 1
        const result = applyEvent(state, event)
        state = result.state
        if (result.endsStream) endsStream = true
        const patch = event.type === "thread.updated" ? threadPatchFromEvent(event.payload) : null
        if (patch) {
          threads = threads.map((thread) =>
            thread.id === threadId ? { ...thread, ...patch, updatedAt: event.createdAt } : thread,
          )
        }
      }
      if (added === 0) continue
      state = { ...state, events: list }
      threadStates[threadId] = state
      const mirrorActive =
        this.state.activeThreadId === null || this.state.activeThreadId === threadId
      if (mirrorActive) {
        mirroredEvents = list
        if (endsStream) mirroredStream = ""
      }
    }
    if (replayOf !== undefined && firstReplay) {
      threadStates[replayOf] = { ...(threadStates[replayOf] ?? emptyThreadState()), loaded: true }
    }
    this.state = {
      ...this.state,
      threads,
      threadStates,
      events: mirroredEvents,
      streamingText: mirroredStream,
    }
    this.emit()
  }

  /**
   * 累加某线程的流式文本；已关闭的线程没有状态，直接忽略迟到 delta，
   * 避免后台 run 的文本串到当前活动线程。
   */
  appendDelta(threadId: string, text: string): void {
    this.flushDeltas()
    this.pendingDeltas.set(threadId, text)
    this.flushDeltas()
  }

  /**
   * 排队一段流式文本，下一帧合并写入。模型每秒可能推几十个增量，逐个写入会让整个界面
   * 每个增量都重新渲染一次；合并后每帧最多渲染一次。新事件到达前会先写入已排队的文本。
   */
  queueDelta(threadId: string, text: string): void {
    this.pendingDeltas.set(threadId, (this.pendingDeltas.get(threadId) ?? "") + text)
    this.scheduleFlush()
  }

  /** 排队一段命令输出，和流式文本一起按帧写入。 */
  queueToolOutput(threadId: string, toolCallId: string, delta: string): void {
    const byTool = this.pendingOutput.get(threadId) ?? new Map<string, string>()
    byTool.set(toolCallId, (byTool.get(toolCallId) ?? "") + delta)
    this.pendingOutput.set(threadId, byTool)
    this.scheduleFlush()
  }

  /** 排队一段思考过程，和流式文本一起按帧写入。 */
  queueReasoning(threadId: string, text: string): void {
    this.pendingReasoning.set(threadId, (this.pendingReasoning.get(threadId) ?? "") + text)
    this.scheduleFlush()
  }

  /** 把排队的流式文本、命令输出与思考过程一次写入。 */
  flushDeltas(): void {
    this.flushScheduled = false
    if (
      this.pendingDeltas.size === 0 &&
      this.pendingOutput.size === 0 &&
      this.pendingReasoning.size === 0
    ) {
      return
    }
    const pending = [...this.pendingDeltas]
    const output = [...this.pendingOutput]
    const reasoning = [...this.pendingReasoning]
    this.pendingDeltas.clear()
    this.pendingOutput.clear()
    this.pendingReasoning.clear()
    const threadStates = { ...this.state.threadStates }
    let streamingText = this.state.streamingText
    let changed = false
    for (const [threadId, text] of pending) {
      const previous = threadStates[threadId]
      if (!previous) continue
      threadStates[threadId] = { ...previous, streamingText: previous.streamingText + text }
      if (this.state.activeThreadId === threadId) streamingText += text
      changed = true
    }
    for (const [threadId, byTool] of output) {
      const previous = threadStates[threadId]
      if (!previous) continue
      const liveOutput = { ...previous.liveOutput }
      for (const [toolCallId, delta] of byTool) {
        liveOutput[toolCallId] = (liveOutput[toolCallId] ?? "") + delta
      }
      threadStates[threadId] = { ...previous, liveOutput }
      changed = true
    }
    for (const [threadId, text] of reasoning) {
      const previous = threadStates[threadId]
      if (!previous) continue
      threadStates[threadId] = { ...previous, liveReasoning: previous.liveReasoning + text }
      changed = true
    }
    if (!changed) return
    this.state = { ...this.state, threadStates, streamingText }
    this.emit()
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    this.schedule(() => this.flushDeltas())
  }

  /** 写入单个线程状态并通知订阅者。 */
  private writeThreadState(threadId: string, value: ThreadViewState): void {
    this.state = { ...this.state, threadStates: { ...this.state.threadStates, [threadId]: value } }
    this.emit()
  }

  /** 读取活动线程的事件镜像；线程不存在时为空。 */
  private eventsFor(
    threadStates: Record<string, ThreadViewState>,
    threadId: string | null,
  ): ThreadEvent[] {
    return threadId ? (threadStates[threadId]?.events ?? []) : []
  }

  /** 读取活动线程的流式文本镜像；线程不存在时为空。 */
  private streamingFor(
    threadStates: Record<string, ThreadViewState>,
    threadId: string | null,
  ): string {
    return threadId ? (threadStates[threadId]?.streamingText ?? "") : ""
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 在 React 组件中读取 store。 */
export function useAppStore(store: AppStore): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
