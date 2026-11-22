/** Agent 服务错误；code 供 RPC 与 UI 稳定识别。 */

export class AgentInstanceIdTakenError extends Error {
  readonly code = "AGENT_INSTANCE_ID_TAKEN"

  constructor(instanceId: string) {
    super(`agent instance ID is already in use: ${instanceId}`)
    this.name = "AgentInstanceIdTakenError"
  }
}

/** 同一 thread 已有活跃 run 时抛出的错误。 */
export class RunAlreadyActiveError extends Error {
  readonly code = "RUN_ALREADY_ACTIVE"

  constructor(threadId: string) {
    super(`RUN_ALREADY_ACTIVE: thread ${threadId} already has an active run`)
    this.name = "RunAlreadyActiveError"
  }
}

/** 全局活跃 run 达到上限时抛出的错误。 */
export class TooManyActiveRunsError extends Error {
  readonly code = "TOO_MANY_ACTIVE_RUNS"

  constructor(limit: number) {
    super(`TOO_MANY_ACTIVE_RUNS: at most ${limit} runs may be active at once`)
    this.name = "TooManyActiveRunsError"
  }
}

/** 排队 run 达到上限时抛出的错误；活跃 run 会进入队列而不是直接失败。 */
export class RunQueueFullError extends Error {
  readonly code = "RUN_QUEUE_FULL"

  constructor(limit: number) {
    super(`RUN_QUEUE_FULL: at most ${limit} runs may be queued`)
    this.name = "RunQueueFullError"
  }
}

/** 会话选定的 Agent 或实例目前不能接收 run。 */
export class RunSelectionUnavailableError extends Error {}
