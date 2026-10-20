/** Renderer 的应用状态；组件通过 useSyncExternalStore 订阅。 */
import { useSyncExternalStore } from "react"
import type { Project, Thread, ThreadEvent } from "@pigcode/contracts"
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
