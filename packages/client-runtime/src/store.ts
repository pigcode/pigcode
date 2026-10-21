/** Renderer 的应用状态；组件通过 useSyncExternalStore 订阅。 */
import { useSyncExternalStore } from "react"
import type { Project, ProviderCapabilities, Thread, ThreadEvent } from "@pigcode/contracts"
import type { ConnectionStatus } from "./connection"

/** 单个线程在 Renderer 中的运行状态。 */
export type ThreadViewStatus =
  "idle" | "queued" | "running" | "waiting-approval" | "completed" | "failed" | "interrupted"

/** 每个打开线程独立维护的事件、流式文本与运行状态。 */
export interface ThreadViewState {
  events: ThreadEvent[]
  streamingText: string
  status: ThreadViewStatus
  pendingApprovals: number
  lastError: string | null
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
  /** 当前线程 provider 的能力描述；尚未加载时为 null。 */
  providerCapabilities: ProviderCapabilities | null
  /** 当前 provider 可选的模型 id 列表；未知时为空。 */
  providerModels: string[]
  /** 插件启停后递增，通知依赖 provider 列表的界面重新拉取。 */
  providerRevision: number
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
    status: "idle",
    pendingApprovals: 0,
    lastError: null,
  }
}

/** 事件类型到线程状态的映射；未知事件保持原状态。 */
const STATUS_AFTER_EVENT: Record<string, ThreadViewStatus> = {
  "run.queued": "queued",
  "run.started": "running",
  "approval.requested": "waiting-approval",
  "approval.resolved": "running",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.interrupted": "interrupted",
}

/** 进入终态后，迟到的审批事件不能再把状态改回运行中。 */
const TERMINAL_STATUSES = new Set<ThreadViewStatus>(["completed", "failed", "interrupted"])

/** 子 agent 的完成消息带有 parentToolUseId，不能清空主线程的流式文本。 */
function isSubagentMessage(event: ThreadEvent): boolean {
  if (typeof event.payload !== "object" || event.payload === null) return false
  const parent = (event.payload as { parentToolUseId?: unknown }).parentToolUseId
  return typeof parent === "string" && parent.length > 0
}

/** 从 thread.updated 的 payload 中读取标题；没有标题时返回 null。 */
function titleFromEvent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const title = (payload as { title?: unknown }).title
  return typeof title === "string" && title.trim().length > 0 ? title : null
}

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
  providerCapabilities: null,
  providerModels: [],
  providerRevision: 0,
  threadStates: {},
  openThreadIds: [],
}

/** 不可变状态容器；每次变更都替换快照并通知订阅者。 */
export class AppStore {
  private state: AppState = initialState
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  /** 打开线程：初始化独立状态并加入打开列表。 */
  openThread(threadId: string): void {
    const threadStates = { ...this.state.threadStates }
    if (!threadStates[threadId]) threadStates[threadId] = emptyThreadState()
    const openThreadIds = this.state.openThreadIds.includes(threadId)
      ? this.state.openThreadIds
      : [...this.state.openThreadIds, threadId]
    this.state = { ...this.state, threadStates, openThreadIds }
    this.emit()
  }

  /** 关闭线程：删除状态；若关闭的是活动线程，则激活相邻线程。 */
  closeThread(threadId: string): void {
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

  /** 切换活动线程，并同步活动镜像。 */
  setActiveThread(threadId: string): void {
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
    const previous = this.state.threadStates[event.threadId] ?? emptyThreadState()
    const events = previous.events.some((item) => item.seq === event.seq)
      ? previous.events
      : [...previous.events, event]
    const mapped = STATUS_AFTER_EVENT[event.type]
    const status =
      mapped && !(event.type === "approval.resolved" && TERMINAL_STATUSES.has(previous.status))
        ? mapped
        : previous.status
    const subagent = isSubagentMessage(event)
    const next: ThreadViewState = {
      ...previous,
      events,
      streamingText: event.type === "message.completed" && !subagent ? "" : previous.streamingText,
      status,
      pendingApprovals: pendingApprovalsAfter(previous, event),
      lastError:
        event.type === "run.failed"
          ? (errorFromPayload(event.payload) ?? previous.lastError)
          : previous.lastError,
    }
    const threadStates = { ...this.state.threadStates, [event.threadId]: next }
    const title = event.type === "thread.updated" ? titleFromEvent(event.payload) : null
    const threads = title
      ? this.state.threads.map((thread) =>
          thread.id === event.threadId
            ? { ...thread, title, updatedAt: event.createdAt }
            : thread,
        )
      : this.state.threads
    const mirrorActive =
      this.state.activeThreadId === null || this.state.activeThreadId === event.threadId
    this.state = {
      ...this.state,
      threads,
      threadStates,
      events: mirrorActive ? events : this.state.events,
      streamingText:
        mirrorActive && event.type === "message.completed" && !subagent
          ? ""
          : this.state.streamingText,
    }
    this.emit()
  }

  /**
   * 累加某线程的流式文本；已关闭的线程没有状态，直接忽略迟到 delta，
   * 避免后台 run 的文本串到当前活动线程。
   */
  appendDelta(threadId: string, text: string): void {
    const previous = this.state.threadStates[threadId]
    if (!previous) return
    const threadStates = {
      ...this.state.threadStates,
      [threadId]: { ...previous, streamingText: previous.streamingText + text },
    }
    const mirrorActive = this.state.activeThreadId === threadId
    this.state = {
      ...this.state,
      threadStates,
      streamingText: mirrorActive ? this.state.streamingText + text : this.state.streamingText,
    }
    this.emit()
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
