/** 全局运行队列、排队条目与内存中的 run 句柄。 */
import type { ProviderEvent, RunStatus } from "@pigcode/contracts"
import type {
  ProviderDriver,
  ProviderSessionHandle,
  SessionMcp,
  UserInput,
} from "./driver"

/** 运行期内存状态；终态事件到达后从 activeRuns 移除。 */
export interface ActiveRun {
  runId: string
  threadId: string
  session: ProviderSessionHandle
  driver: ProviderDriver
  controller: AbortController
  emitLive: ((event: ProviderEvent) => void) | undefined
  status: RunStatus
  done: Promise<void>
  resolveDone: () => void
  approvals: Set<string>
}

/**
 * 排队中的 run：此时还没有 provider 会话，避免为尚未开始的 run 提前启动
 * Codex app-server 或 Claude Query。会话在真正启动时创建。
 */
export interface QueuedRun {
  runId: string
  threadId: string
  driver: ProviderDriver
  input: UserInput
  emitLive: ((event: ProviderEvent) => void) | undefined
  controller: AbortController
  done: Promise<void>
  resolveDone: () => void
  queuedAt: string
  cwd: string
  permissionMode: string
  model: string | null
  nativeSessionId: string | null
  forkFromNativeSessionId?: string
  /** 复用已有 provider_sessions 行时传入，保证 driver 内部 state 使用同一个 id。 */
  sessionId?: string
  mcp?: SessionMcp
}

/** run.list 返回的运行概要；queuedAt 只对排队中的 run 存在。 */
export interface RunSummary {
  runId: string
  threadId: string
  status: RunStatus
  queuedAt?: string
}

/** 有界 FIFO 队列；达到上限时 push 返回 false。 */
export class RunQueue<T> {
  private readonly items: T[] = []

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.items.length
  }

  values(): readonly T[] {
    return [...this.items]
  }

  push(item: T): boolean {
    if (this.items.length >= this.limit) return false
    this.items.push(item)
    return true
  }

  shift(): T | undefined {
    return this.items.shift()
  }

  remove(match: (item: T) => boolean): T | undefined {
    const index = this.items.findIndex(match)
    return index < 0 ? undefined : this.items.splice(index, 1)[0]
  }

  clear(): void {
    this.items.length = 0
  }
}
