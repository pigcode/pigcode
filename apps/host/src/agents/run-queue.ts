/** 全局运行队列、排队条目与内存中的 run 句柄。 */
import type { AgentEvent, RunStatus } from "@pigcode/contracts"
import type { AgentDriver, AgentSessionHandle, SessionMcp, UserInput } from "./driver"

/** 运行期内存状态；终态事件到达后从 activeRuns 移除。 */
export interface ActiveRun {
  runId: string
  threadId: string
  session: AgentSessionHandle
  driver: AgentDriver
  controller: AbortController
  emitLive: ((event: AgentEvent) => void) | undefined
  status: RunStatus
  done: Promise<void>
  resolveDone: () => void
  approvals: Set<string>
  /** 已经流给 UI、还没有被 message.completed 持久化的助手文本。 */
  liveText: string
  /** 当前这段思考第一次流出增量的时间；思考结束时据此记下持续时长。 */
  reasoningStartedAt?: number | undefined
  /**
   * 这一轮在接续已有的原生会话（resume 或 fork），原生会话还没回应过。此时 driver 报「原生会话不存在」
   * 就改开新会话重试，而不是让 run 失败。
   */
  resuming?: boolean
  /** 开一个新的原生会话替换这一轮的会话；原来那一行标成 stopped。 */
  startFresh?: () => Promise<AgentSessionHandle>
}

/**
 * 排队中的 run：此时还没有 Agent 会话，避免为尚未开始的 run 提前启动
 * Codex app-server 或 Claude Query。会话在真正启动时创建。
 */
export interface QueuedRun {
  runId: string
  threadId: string
  driver: AgentDriver
  /** 这个 run 用的 Agent 实例；缺省时等于 driver.id（默认实例）。 */
  instanceId: string
  input: UserInput
  emitLive: ((event: AgentEvent) => void) | undefined
  controller: AbortController
  done: Promise<void>
  resolveDone: () => void
  queuedAt: string
  cwd: string
  permissionMode: string
  planMode?: boolean
  model: string | null
  nativeSessionId: string | null
  forkFromNativeSessionId?: string
  /** 复用已有 agent_sessions 行时传入，保证 driver 内部 state 使用同一个 id。 */
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
