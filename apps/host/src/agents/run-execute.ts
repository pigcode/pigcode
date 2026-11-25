import { updateThreadModes } from "./execution-modes"
/** 执行一轮 run：调用 driver.send，把事件映射成线程事件；原生会话接不上时换新会话重试一次。 */
import { appendImageAttachmentFallback } from "@pigcode/plugin-sdk"
import type { Context } from "cordis"
import type { AgentRuntime, ApprovalDecision, QuestionRequest, UserInput } from "./driver"
import type { ActiveRun } from "./run-queue"
import { mapAgentEvent, type RunEventHooks } from "./run-events"
import { handoffForRun } from "./handoff-delivery"
import { freshSessionHandoff, recomposePendingHandoff } from "./switching"
import { isThreadReadTool } from "./thread-read-tool"

/**
 * 一轮运行完全收不到 Agent 事件多久后提示用户（#83）。
 * Codex 偶尔会在 turn/start 之后不再发任何通知，界面就一直转圈；这里只提示，不替用户中断。
 * 长时间没有输出的命令也可能触发，所以文案要允许「继续等」。
 */
const STALL_NOTICE_MS = 120_000
const STALL_NOTICE_SECONDS = STALL_NOTICE_MS / 1000

/** execute 需要的 Host 闭包。 */
export interface ExecuteDeps {
  ctx: Context
  activeRuns: Map<string, ActiveRun>
  hooks: RunEventHooks
  requestApproval: (
    run: ActiveRun,
    request: Parameters<AgentRuntime["requestApproval"]>[0],
  ) => Promise<ApprovalDecision>
  askQuestions: (
    run: ActiveRun,
    request: QuestionRequest,
    signal?: AbortSignal,
  ) => Promise<string[]>
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
    // 每来一条 Agent 事件就重新计时；等审批或等用户回答时不算卡住，把计时停掉。
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let stallNoticed = false
    const clearStall = (): void => {
      if (stallTimer === undefined) return
      clearTimeout(stallTimer)
      stallTimer = undefined
    }
    const armStall = (): void => {
      clearStall()
      if (stallNoticed || !isCurrent(run)) return
      stallTimer = setTimeout(() => {
        stallTimer = undefined
        if (!isCurrent(run)) return
        stallNoticed = true
        mapAgentEvent(
          run,
          {
            type: "notice",
            level: "warning",
            key: "run.stalled",
            params: { seconds: String(STALL_NOTICE_SECONDS) },
          },
          deps.hooks,
        )
      }, STALL_NOTICE_MS)
    }
    const runtime: AgentRuntime = {
      signal: run.controller.signal,
      emit: (event) => {
        armStall()
        if (event.type === "session.started") run.resuming = false
        if (event.type === "run.failed" && isLost(event.message)) {
          lost = true
          return
        }
        mapAgentEvent(run, event, deps.hooks)
      },
      requestApproval: (request) => {
        if (!isCurrent(run)) return Promise.resolve<ApprovalDecision>("deny")
        // 内置的 thread_read 只读会话历史，不弹审批；否则交接里让 agent 去读，它会停在那里等人点。
        if (isThreadReadTool(request.toolName))
          return Promise.resolve<ApprovalDecision>("allow-once")
        clearStall()
        return deps.requestApproval(run, request).finally(armStall)
      },
      setPlanMode: (planMode) => {
        if (!isCurrent(run) || deps.ctx.threads.get(run.threadId)?.planMode === planMode) return
        updateThreadModes(deps.ctx, run.threadId, { planMode })
      },
      askQuestions: (request, signal) => {
        if (!isCurrent(run)) return Promise.resolve([])
        clearStall()
        return deps.askQuestions(run, request, signal).finally(armStall)
      },
    }
    armStall()
    const effectiveInput = prepareDriverInput(run, input)
    try {
      await run.driver.send(run.session, effectiveInput, runtime)
      if (!isCurrent(run)) return
      if (lost) {
        clearStall()
        await retryWithFreshSession(run, input)
        return
      }
      deps.hooks.finish(run, "completed", "run.completed", {})
    } catch (error) {
      if (!isCurrent(run)) return
      if (isLost(error instanceof Error ? error.message : String(error))) {
        clearStall()
        await retryWithFreshSession(run, input)
        return
      }
      fail(run, error)
    } finally {
      clearStall()
    }
  }

  /** 原生会话接不上：换成新的原生会话，带上这一轮之前的对话，把同一条输入再发一次。 */
  async function retryWithFreshSession(run: ActiveRun, input: UserInput): Promise<void> {
    run.resuming = false
    try {
      await run.driver.dispose(run.session).catch(() => undefined)
      if (!run.startFresh) throw new Error("agent session cannot be restarted")
      const previousCwd = run.session.cwd
      run.session = await run.startFresh()
      if (run.session.cwd !== previousCwd) {
        await deps.ctx.get("checkpoints")?.moveExecution(run.runId, run.session.cwd, run.controller.signal)
      }
      const imageCount = input.attachments?.length ?? 0
      const fresh = freshSessionHandoff(
        deps.ctx,
        run.threadId,
        run.runId,
        input.text,
        run.instanceId,
        imageCount,
      )
      const handoff = handoffForRun(
        deps.ctx.storage.db,
        run.threadId,
        run.runId,
        input.text,
        fresh,
        {
          images: imageCount,
          recompose: (pendingHandoff, budget) =>
            recomposePendingHandoff(deps.ctx, run.threadId, pendingHandoff, budget, run.runId),
        },
      )
      const rest: UserInput = { ...input }
      delete rest.handoff
      await execute(run, handoff === null ? rest : { ...rest, handoff })
    } catch (error) {
      fail(run, error)
    }
  }

  return execute
}

/** 不支持原生看图的 Agent 自动把已落盘的图片路径说明附加到文本末尾。 */
function prepareDriverInput(run: ActiveRun, input: UserInput): UserInput {
  if (!input.attachments || input.attachments.length === 0) return input
  const nativeImages = run.driver.handlesImages
    ? run.driver.handlesImages(run.session)
    : run.driver.features?.images === true
  if (nativeImages) return input
  return {
    ...input,
    text: appendImageAttachmentFallback(input.text, input.attachments),
  }
}
/** Keep the next queued message out of the driver until its previous native turn is cleaned up. */
export function trackRunExecution(ctx: Context, send: ReturnType<typeof createExecute>) {
  const executing = new Set<ActiveRun>()
  return {
    busy: (threadId: string) => Array.from(executing).some((run) => run.threadId === threadId),
    execute(run: ActiveRun, input: UserInput): void {
      const checkpoints = ctx.get("checkpoints")
      let markSettled!: () => void
      const settled = new Promise<void>((resolve) => { markSettled = resolve })
      checkpoints?.trackExecution(run.runId, settled)
      executing.add(run)
      void send(run, input)
        .finally(async () => {
          await run.interruption
          markSettled()
          await checkpoints?.waitForFinal(run.runId)
          executing.delete(run)
          ctx.get("messageQueue")?.schedule(run.threadId)
        })
        .catch((error) => console.error("[host] agent execution failed", error))
    },
  }
}
