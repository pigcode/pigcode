/** 执行一轮 run：调用 driver.send，把事件映射成线程事件；原生会话接不上时换新会话重试一次。 */
import type { Context } from "cordis"
import type { AgentRuntime, ApprovalDecision, QuestionRequest, UserInput } from "./driver"
import type { ActiveRun } from "./run-queue"
import { mapAgentEvent, type RunEventHooks } from "./run-events"
import { startsWithAgentCommand } from "./agent-command"
import { deferHandoff, freshSessionHandoff } from "./switching"

/** execute 需要的 Host 闭包。 */
export interface ExecuteDeps {
  ctx: Context
  activeRuns: Map<string, ActiveRun>
  hooks: RunEventHooks
  requestApproval: (
    run: ActiveRun,
    request: Parameters<AgentRuntime["requestApproval"]>[0],
  ) => Promise<ApprovalDecision>
  askQuestions: (run: ActiveRun, request: QuestionRequest) => Promise<string[]>
}

/** 生成 execute；异常统一转成 run.failed。 */
export function createExecute(
  deps: ExecuteDeps,
): (run: ActiveRun, input: UserInput) => Promise<void> {
  const isCurrent = (run: ActiveRun): boolean => deps.activeRuns.get(run.runId) === run

  function fail(run: ActiveRun, error: unknown): void {
    if (!isCurrent(run)) return
    const message = error instanceof Error ? error.message : String(error)
    deps.hooks.finish(run, "failed", "run.failed", { message }, { code: "AGENT_ERROR", message })
  }

  async function execute(run: ActiveRun, input: UserInput): Promise<void> {
    // Claude 在 send 里才 resume：原生会话不在了，CLI 报错退出。这时不让 run 失败，改开新会话重试一次。
    let lost = false
    const isLost = (message: string): boolean =>
      run.resuming === true && run.driver.isSessionNotFound?.(message) === true
    const runtime: AgentRuntime = {
      signal: run.controller.signal,
      emit: (event) => {
        if (event.type === "session.started") run.resuming = false
        if (event.type === "run.failed" && isLost(event.message)) {
          lost = true
          return
        }
        mapAgentEvent(run, event, deps.hooks)
      },
      requestApproval: (request) =>
        isCurrent(run)
          ? deps.requestApproval(run, request)
          : Promise.resolve<ApprovalDecision>("deny"),
      askQuestions: (request) =>
        isCurrent(run) ? deps.askQuestions(run, request) : Promise.resolve([]),
    }
    try {
      await run.driver.send(run.session, input, runtime)
      if (!isCurrent(run)) return
      if (lost) {
        await retryWithFreshSession(run, input)
        return
      }
      deps.hooks.finish(run, "completed", "run.completed", {})
    } catch (error) {
      if (!isCurrent(run)) return
      if (isLost(error instanceof Error ? error.message : String(error))) {
        await retryWithFreshSession(run, input)
        return
      }
      fail(run, error)
    }
  }

  /** 原生会话接不上：换成新的原生会话，带上这一轮之前的对话，把同一条输入再发一次。 */
  async function retryWithFreshSession(run: ActiveRun, input: UserInput): Promise<void> {
    run.resuming = false
    try {
      await run.driver.dispose(run.session).catch(() => undefined)
      if (!run.startFresh) throw new Error("agent session cannot be restarted")
      run.session = await run.startFresh()
      const handoff = freshSessionHandoff(deps.ctx, run.threadId, run.runId)
      const rest: UserInput = { ...input }
      delete rest.handoff
      // 以 Agent 命令开头的消息不带交接，交接记下来留给下一轮。
      if (handoff !== null && startsWithAgentCommand(input.text)) {
        deferHandoff(deps.ctx, run.threadId, handoff)
        await execute(run, rest)
        return
      }
      await execute(run, handoff === null ? rest : { ...rest, handoff })
    } catch (error) {
      fail(run, error)
    }
  }

  return execute
}
