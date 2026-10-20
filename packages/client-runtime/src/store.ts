/** Renderer 的应用状态；组件通过 useSyncExternalStore 订阅。 */
import { useSyncExternalStore } from "react"
import type { Project, ProviderCapabilities, Thread, ThreadEvent } from "@pigcode/contracts"
import type { ConnectionStatus } from "./connection"

/** Renderer 全局状态快照。 */
export interface AppState {
  status: ConnectionStatus
  projects: Project[]
  threads: Thread[]
  activeProjectId: string | null
  activeThreadId: string | null
  events: ThreadEvent[]
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

  addEvent(event: ThreadEvent): void {
    if (this.state.events.some((item) => item.seq === event.seq)) return
    const next: AppState = { ...this.state, events: [...this.state.events, event] }
    if (event.type === "message.completed") next.streamingText = ""
    this.state = next
    this.emit()
  }

  appendDelta(_runId: string, text: string): void {
    this.state = { ...this.state, streamingText: this.state.streamingText + text }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 在 React 组件中读取 store。 */
export function useAppStore(store: AppStore): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
