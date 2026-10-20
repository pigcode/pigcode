/** provider run 生命周期错误；code 供 RPC 与 UI 稳定识别。 */

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
