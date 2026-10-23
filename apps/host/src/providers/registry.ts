/** 注册 provider driver，并把一次 run 的规范化事件映射为线程事件。 */
import type { Context } from "cordis"
import type { RunStatus, ThreadEvent } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
  ApprovalRequest,
  ProviderDriver,
  ProviderRunConfig,
  ProviderRuntime,
  UserInput,
} from "./driver"
import { FakeProviderDriver } from "./fake"
import { createAgentCatalog } from "./agent-catalog"
import { RunAlreadyActiveError, RunQueueFullError, TooManyActiveRunsError } from "./errors"
import { RunQueue, type ActiveRun, type QueuedRun } from "./run-queue"
import { launchRun, type LaunchDeps } from "./run-launch"
import { recoverAfterRestart } from "./restart"
import { maybeAutoTitle } from "./title"
import { mapProviderEvent, type RunEventHooks } from "./run-events"
import { disposeSession, pendingForkFromNativeSessionId, switchProvider } from "./switching"
import { threadCwd } from "../services/worktrees"
import { ApprovalBridge } from "./approval-bridge"
import { ProviderSessionStore } from "./session-store"
import { PendingRequestStore } from "../storage/pending-request-store"
import { RunStore } from "../storage/run-store"
import type { ApprovalHandle, ProvidersService } from "./service"
import { createQuestionFlow } from "./questions"

export type { ApprovalHandle, ProvidersService, StartRunOptions, StartRunResult } from "./service"

declare module "cordis" {
  interface Context {
    providers: ProvidersService
  }
}
/** providers 插件依赖的线程、事件与存储服务。 */
export const inject = ["threads", "sessions", "storage", "projects"]
export { RunAlreadyActiveError, TooManyActiveRunsError, RunQueueFullError }

/** 注册 provider driver，并把一次 run 的规范化事件映射为线程事件。 */
export function apply(ctx: Context, config: ProviderRunConfig = {}): void {
  const maxConcurrentRuns = config.maxConcurrentRuns ?? 4
  const maxQueuedRuns = config.maxQueuedRuns ?? 32
  // Claude Code、Codex 与第三方 agent 都由各自的插件注册；Host 只自带开发与测试用的 fake。
  const drivers = new Map<string, ProviderDriver>()
  if (config.fake !== false || process.env.PIGCODE_PROVIDER === "fake") {
    const fake = new FakeProviderDriver({
      callTool: (threadId, name, input) => {
        const bridge = ctx.reflect.get("mcpBridge")
        if (!bridge) return Promise.reject(new Error("MCP tools are not available"))
        return bridge.callTool(threadId, name, input)
      },
    })
    drivers.set(fake.id, fake)
  }
  const agents = createAgentCatalog(ctx, drivers)
  const runs = new RunStore(ctx.storage.db)
  const pendingRequests = new PendingRequestStore(ctx.storage.db)
  const providerSessions = new ProviderSessionStore(ctx.storage.db)
  const approvals = new ApprovalBridge()
  const activeRuns = new Map<string, ActiveRun>()
  const activeThreads = new Set<string>()
  const queue = new RunQueue<QueuedRun>(maxQueuedRuns)
  /** 正在异步创建 provider 会话的 run 数；用于避免并发空位被重复占用。 */
  let launching = 0
  /** 追加一条线程事件并触发实时订阅者。 */
  function append(
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ): void {
    ctx.sessions.append({
      threadId,
      runId,
      type,
      payload,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    })
  }

  /** 结束 run：写终态事件、处理未决审批并释放内存状态。 */
  function finishRun(
    run: ActiveRun,
    status: "completed" | "failed" | "interrupted",
    type: "run.completed" | "run.failed" | "run.interrupted",
    payload: unknown,
    error?: { code: string; message: string },
  ): void {
    if (activeRuns.get(run.runId) !== run) return
    run.status = status
    runs.setStatus(run.runId, status, error)
    // 未决审批必须先于终态事件写入，否则 UI 会把 approval.resolved 当成 run 仍在运行。
    settlePending(run)
    // 中断或失败时，已经流给 UI 的半截回复只存在于实时通道；落成一条消息，重开线程后仍能看到。
    if (status !== "completed" && run.liveText.trim()) {
      append(run.threadId, run.runId, "message.completed", {
        role: "assistant",
        text: run.liveText,
        partial: true,
      })
    }
    run.liveText = ""
    append(run.threadId, run.runId, type, payload)
    activeRuns.delete(run.runId)
    activeThreads.delete(run.threadId)
    run.resolveDone()
    // 终态释放了并发空位，按 FIFO 启动排队中的 run。
    pump()
  }

  /** 把 run 的未决审批以 deny、未答问题以空答案结束，避免 driver 永久等待。 */
  function settlePending(run: ActiveRun): void {
    for (const requestId of run.approvals) {
      if (questions.cancel(run, requestId)) continue
      if (!approvals.resolve(requestId, "deny")) continue
      pendingRequests.resolve(requestId)
      append(run.threadId, run.runId, "approval.resolved", {
        requestId,
        id: requestId,
        decision: "deny",
        reason: "run-ended",
      })
    }
    run.approvals.clear()
  }

  const questions = createQuestionFlow({ append, pendingRequests, runs, activeRuns })

  /** provider 事件映射所需的 Host 回调。 */
  const runEventHooks: RunEventHooks = {
    isActive: (run) => activeRuns.get(run.runId) === run,
    append,
    updateNativeSessionId: (sessionId, nativeSessionId) =>
      providerSessions.updateNativeSessionId(sessionId, nativeSessionId),
    finish: finishRun,
  }

  /** 发起审批：持久化 pending 行、写事件、置为 waiting-approval 并等待 UI 决议。 */
  function requestApproval(
    threadId: string,
    runId: string,
    request: ApprovalRequest,
  ): ApprovalHandle {
    const runRow = ctx.storage.db.prepare(`SELECT thread_id FROM runs WHERE id = ?`).get(runId) as
      { thread_id: string } | undefined
    if (!runRow || runRow.thread_id !== threadId) throw new Error(`run not found: ${runId}`)

    const requestId = `req_${randomUUID()}`
    pendingRequests.create({
      id: requestId,
      threadId,
      runId,
      kind: "approval",
      providerRequestId: null,
      payload: request,
      createdAt: new Date().toISOString(),
    })
    append(threadId, runId, "approval.requested", {
      requestId,
      id: requestId,
      ...request,
    })
    runs.setStatus(runId, "waiting-approval")
    const active = activeRuns.get(runId)
    if (active) {
      active.status = "waiting-approval"
      active.approvals.add(requestId)
    }
    const decision = approvals.wait(requestId, { threadId, runId })
    return { requestId, decision }
  }

  /** 启动排队 run：此时才创建 provider 会话，避免为未开始的 run 提前启动子进程。 */
  /** 在并发空位出现时按 FIFO 启动排队 run；launching 计入正在创建会话的 run。 */
  function pump(): void {
    while (activeRuns.size + launching < maxConcurrentRuns) {
      const entry = queue.shift()
      if (!entry) return
      launching += 1
      void launchRun(entry, launchDeps).finally(() => {
        launching -= 1
        pump()
      })
    }
  }

  /** 异步执行 driver.send；异常统一转成 run.failed。 */
  async function execute(run: ActiveRun, input: UserInput): Promise<void> {
    const runtime: ProviderRuntime = {
      signal: run.controller.signal,
      emit: (event) => mapProviderEvent(run, event, runEventHooks),
      requestApproval: (request) => {
        if (activeRuns.get(run.runId) !== run) return Promise.resolve<ApprovalDecision>("deny")
        return requestApproval(run.threadId, run.runId, request).decision
      },
      askQuestions: (request) =>
        activeRuns.get(run.runId) === run ? questions.ask(run, request) : Promise.resolve([]),
    }
    try {
      await run.driver.send(run.session, input, runtime)
      if (activeRuns.get(run.runId) === run) {
        finishRun(run, "completed", "run.completed", {})
      }
    } catch (error) {
      if (activeRuns.get(run.runId) !== run) return
      const message = error instanceof Error ? error.message : String(error)
      finishRun(
        run,
        "failed",
        "run.failed",
        { message },
        {
          code: "PROVIDER_ERROR",
          message,
        },
      )
    }
  }

  /** launchRun 所需的 Host 闭包；放在 execute 之后以便引用。 */
  const launchDeps: LaunchDeps = {
    ctx,
    providerSessions,
    runs,
    activeRuns,
    activeThreads,
    append,
    execute,
    settingsFor: agents.settingsFor,
  }

  /** 取消排队中的 run；此时尚未创建 provider 会话，只需写终态并释放线程。 */
  function cancelQueuedRun(runId: string): boolean {
    const entry = queue.remove((item) => item.runId === runId)
    if (!entry) return false
    runs.setStatus(entry.runId, "interrupted")
    append(entry.threadId, entry.runId, "run.interrupted", {})
    activeThreads.delete(entry.threadId)
    entry.resolveDone()
    return true
  }

  /** 中断单个活跃或排队中的 run；未知 run 返回 false。 */
  function interruptRun(runId: string): boolean {
    if (cancelQueuedRun(runId)) return true
    const run = activeRuns.get(runId)
    if (!run) return false
    run.controller.abort()
    void run.driver.interrupt(run.session).catch(() => undefined)
    finishRun(run, "interrupted", "run.interrupted", {})
    return true
  }

  /** 中断所有排队与活跃 run；先复制 id，取消过程会修改集合。 */
  function interruptAll(): void {
    for (const entry of [...queue.values()]) cancelQueuedRun(entry.runId)
    for (const runId of [...activeRuns.keys()]) interruptRun(runId)
  }

  /**
   * 注销 driver（插件停用或卸载）：它的会话不能再继续，排队的取消、运行中的中断并释放会话，
   * 免得留下插件启动的子进程。
   */
  function unregisterDriver(driverId: string): void {
    const driver = drivers.get(driverId)
    if (!driver) return
    for (const entry of queue.values()) {
      if (entry.driver === driver) cancelQueuedRun(entry.runId)
    }
    for (const run of [...activeRuns.values()]) {
      if (run.driver !== driver) continue
      interruptRun(run.runId)
      void driver.dispose(run.session).catch(() => undefined)
    }
    drivers.delete(driverId)
    agents.invalidate(driverId)
  }

  const service: ProvidersService = {
    register(driver) {
      drivers.set(driver.id, driver)
      agents.invalidate(driver.id)
    },
    unregister: unregisterDriver,
    list() {
      return [...drivers.values()].map((driver) => ({
        id: driver.id,
        displayName: driver.displayName,
        capabilities: driver.capabilities,
      }))
    },
    detect: (options) => agents.detect(options),
    models: (providerId) => agents.models(providerId),
    defaultProvider: () => agents.defaultProvider(),
    configuredDefaultProvider: () => agents.configuredDefault(),
    setDefaultProvider: (providerId) => agents.setDefaultProvider(providerId),
    getSettings: (providerId) => agents.settingsFor(providerId),
    updateSettings: (providerId, values) => agents.updateSettings(providerId, values),
    async switchProvider(threadId, providerId, modelId) {
      // 运行中或排队中的线程不能切换：否则旧会话被 dispose，正在跑的 run 会失去驱动。
      if (activeThreads.has(threadId)) throw new RunAlreadyActiveError(threadId)
      if (!drivers.has(providerId)) throw new Error(`provider not found: ${providerId}`)
      return switchProvider(
        ctx,
        providerSessions,
        threadId,
        providerId,
        modelId ?? null,
        (session) => disposeSession(drivers, session),
      )
    },
    async startRun(threadId, text, emitLive, options = {}) {
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      if (activeThreads.has(threadId)) throw new RunAlreadyActiveError(threadId)
      // 切换后使用线程最近选择的 provider，未切换过时回退到创建时的默认值。
      const providerId = thread.lastProviderId ?? thread.defaultProviderId
      const driver = drivers.get(providerId)
      if (!driver) throw new Error(`provider not found: ${providerId}`)
      const shouldQueue = activeRuns.size + launching >= maxConcurrentRuns
      if (shouldQueue && queue.size >= maxQueuedRuns) throw new RunQueueFullError(maxQueuedRuns)

      // activeThreads 同时覆盖运行中与排队中的线程，保证同一线程只有一个 run。
      activeThreads.add(threadId)
      const reserved = !shouldQueue
      if (reserved) launching += 1
      try {
        const startedAt = new Date().toISOString()
        const activeSession = providerSessions.findActive(threadId, driver.id)
        const forkFrom = pendingForkFromNativeSessionId(ctx, threadId)
        const runId = `run_${randomUUID()}`
        // 会话在 launchRun 中创建；排队阶段不启动 Codex app-server/Claude Query。
        runs.create({
          id: runId,
          threadId,
          providerSessionId: "pending",
          status: shouldQueue ? "queued" : "running",
          startedAt,
        })
        maybeAutoTitle(ctx, thread, text, runId, append)
        append(threadId, runId, "message.completed", { role: "user", text })

        let resolveDone: () => void = () => undefined
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve
        })
        const mcp = ctx.reflect.get("mcpBridge")?.sessionMcp(threadId)
        const entry: QueuedRun = {
          runId,
          threadId,
          driver,
          input: { text, ...(options.effort ? { effort: options.effort } : {}) },
          emitLive,
          controller: new AbortController(),
          done,
          resolveDone,
          queuedAt: startedAt,
          cwd: threadCwd(ctx, thread.id),
          permissionMode: thread.permissionMode,
          model: thread.lastModelId,
          nativeSessionId: forkFrom ? null : (activeSession?.nativeSessionId ?? null),
          ...(forkFrom ? { forkFromNativeSessionId: forkFrom } : {}),
          ...(activeSession ? { sessionId: activeSession.id } : {}),
          ...(mcp ? { mcp } : {}),
        }
        if (shouldQueue) {
          append(threadId, runId, "run.queued", { queuedAt: startedAt })
          if (!queue.push(entry)) throw new RunQueueFullError(maxQueuedRuns)
          return { runId, done }
        }
        await launchRun(entry, launchDeps)
        return { runId, done }
      } catch (error) {
        activeThreads.delete(threadId)
        throw error
      } finally {
        if (reserved) launching -= 1
      }
    },
    requestApproval(threadId, runId, request) {
      return requestApproval(threadId, runId, request)
    },
    respondApproval(threadId, runId, requestId, decision) {
      const row = ctx.storage.db
        .prepare(`SELECT thread_id, run_id, status FROM pending_requests WHERE id = ?`)
        .get(requestId) as { thread_id: string; run_id: string; status: string } | undefined
      if (!row || row.thread_id !== threadId || row.run_id !== runId || row.status !== "pending") {
        throw new Error(`approval not pending: ${requestId}`)
      }
      if (!approvals.resolve(requestId, decision)) {
        throw new Error(`approval not pending: ${requestId}`)
      }
      pendingRequests.resolve(requestId)
      append(threadId, runId, "approval.resolved", { requestId, id: requestId, decision })
      runs.setStatus(runId, "running")
      const run = activeRuns.get(runId)
      if (run) {
        run.status = "running"
        run.approvals.delete(requestId)
      }
    },
    answerQuestion(threadId, runId, requestId, answers) {
      questions.answer(threadId, runId, requestId, answers)
    },
    getRunStatus(runId) {
      const active = activeRuns.get(runId)
      if (active) return active.status
      const row = ctx.storage.db.prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as
        { status: RunStatus } | undefined
      return row?.status ?? null
    },
    cancelRun(runId) {
      return interruptRun(runId)
    },
    listRuns() {
      return [
        ...[...activeRuns.values()].map((run) => ({
          runId: run.runId,
          threadId: run.threadId,
          status: run.status,
        })),
        ...queue.values().map((entry) => ({
          runId: entry.runId,
          threadId: entry.threadId,
          status: "queued" as const,
          queuedAt: entry.queuedAt,
        })),
      ]
    },
    cancelAll() {
      interruptAll()
    },
    listSessions(threadId) {
      return providerSessions.listByThread(threadId)
    },
    listPendingRequests(threadId) {
      return pendingRequests.listPending(threadId)
    },
    recoverAfterRestart() {
      return recoverAfterRestart(ctx, pendingRequests, providerSessions, append)
    },
  }

  ctx.provide("providers", service)
  ctx.effect(() => () => {
    // Host 退出时把活跃 run 全部置为 interrupted，再清空等待中的审批。
    interruptAll()
    queue.clear()
    activeRuns.clear()
    activeThreads.clear()
    approvals.rejectAll(new Error("host disposed"))
    questions.dispose()
  })
}
apply.inject = inject
