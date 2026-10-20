/** 注册 provider driver，并把一次 run 的规范化事件映射为线程事件。 */
import type { Context } from "cordis"
import type {
  PendingRequest,
  ProviderCapabilities,
  ProviderEvent,
  ProviderSession,
  RunStatus,
  ThreadEvent,
} from "@pigcode/contracts"
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
import { detectClaude, type ClaudeDetection } from "./claude/detect"
import { ClaudeDriver } from "./claude/driver"
import { detectCodex, type CodexDetection } from "./codex/detect"
import { CodexDriver } from "./codex/driver"
import type { CodexModelInfo } from "./codex/models"
import { RunAlreadyActiveError, RunQueueFullError, TooManyActiveRunsError } from "./errors"
import { RunQueue, type ActiveRun, type QueuedRun, type RunSummary } from "./run-queue"
import { mapProviderEvent, type RunEventHooks } from "./run-events"
import {
  defaultProvider,
  disposeSession,
  listProviderModels,
  pendingHandoff,
  resolveThreadCwd,
  switchProvider,
} from "./switching"
import type { Switch } from "./switching"
import { ApprovalBridge } from "./claude/permissions"
import { ProviderSessionStore } from "./claude/session-store"
import { PendingRequestStore } from "../storage/pending-request-store"
import { RunStore } from "../storage/run-store"

/** 一次 run 的句柄；done 在 run 进入终态后 resolve。 */
export interface StartRunResult {
  runId: string
  done: Promise<void>
}

/** 一次审批请求的句柄；decision 在 UI 决议后 resolve。 */
export interface ApprovalHandle {
  requestId: string
  decision: Promise<ApprovalDecision>
}

/** Host 重启恢复时处理的行数。 */
export interface RestartRecovery {
  orphanedRequests: number
  interruptedRuns: number
  orphanedSessions: number
}

/** provider 注册表与运行生命周期入口。 */
export interface ProvidersService {
  register(driver: ProviderDriver): void
  /** 移除插件注册的 driver；插件卸载时由其 effect 清理调用。 */
  unregister(driverId: string): void
  list(): Array<{ id: string; displayName: string; capabilities: ProviderCapabilities }>
  detect(): Promise<{
    claude: ClaudeDetection
    codex: CodexDetection
    fake: { installed: true }
  }>
  /** 读取 provider 的模型目录；M2 只有 Codex 最终会返回真实列表。 */
  models(providerId: string): Promise<CodexModelInfo[]>
  /** 选择新线程默认 provider：显式 env 优先，否则 Claude 已安装且登录时用 Claude。 */
  defaultProvider(): Promise<string>
  /** 切换线程 provider/model，并把 handoff 写入事件日志。 */
  switchProvider(threadId: string, providerId: string, modelId?: string | null): Promise<Switch>
  startRun(
    threadId: string,
    text: string,
    emitLive?: (event: ProviderEvent) => void,
  ): Promise<StartRunResult>
  requestApproval(threadId: string, runId: string, request: ApprovalRequest): ApprovalHandle
  respondApproval(
    threadId: string,
    runId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): void
  getRunStatus(runId: string): RunStatus | null
  cancelRun(runId: string): boolean
  /** 列出运行中与排队中的 run，供 run.list 查询。 */
  listRuns(): RunSummary[]
  /** Host 退出时中断所有活跃与排队中的 run。 */
  cancelAll(): void
  /** 读取线程的 provider 会话记录，用于验证 native session 复用。 */
  listSessions(threadId: string): ProviderSession[]
  /** 读取线程仍未处理的审批/提问请求。 */
  listPendingRequests(threadId: string): PendingRequest[]
  /** Host 启动后清理上一个进程遗留的 run、session 与 pending 请求。 */
  recoverAfterRestart(): RestartRecovery
}
declare module "cordis" {
  interface Context {
    providers: ProvidersService
  }
}
/** providers 插件依赖的线程、事件与存储服务。 */
export const inject = ["threads", "sessions", "storage"]
export { RunAlreadyActiveError, TooManyActiveRunsError, RunQueueFullError }

/** 注册 provider driver，并把一次 run 的规范化事件映射为线程事件。 */
export function apply(ctx: Context, config: ProviderRunConfig = {}): void {
  const maxConcurrentRuns = config.maxConcurrentRuns ?? 4
  const maxQueuedRuns = config.maxQueuedRuns ?? 32
  const drivers = new Map<string, ProviderDriver>()
  const fake = new FakeProviderDriver()
  drivers.set(fake.id, fake)
  const claude = new ClaudeDriver()
  drivers.set(claude.id, claude)
  drivers.set("codex", new CodexDriver())

  const runs = new RunStore(ctx.storage.db)
  const pendingRequests = new PendingRequestStore(ctx.storage.db)
  const providerSessions = new ProviderSessionStore(ctx.storage.db)
  const approvals = new ApprovalBridge()
  const activeRuns = new Map<string, ActiveRun>()
  const activeThreads = new Set<string>()
  const queue = new RunQueue<QueuedRun>(maxQueuedRuns)

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
    append(run.threadId, run.runId, type, payload)
    settlePending(run)
    activeRuns.delete(run.runId)
    activeThreads.delete(run.threadId)
    run.resolveDone()
    // 终态释放了并发空位，按 FIFO 启动排队中的 run。
    pump()
  }

  /** 把 run 的未决审批以 deny 结束，避免 driver 永久等待。 */
  function settlePending(run: ActiveRun): void {
    for (const requestId of run.approvals) {
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

  /** 启动已创建的 run：写 run.started、放入活跃表并执行 driver。 */
  function launchRun(run: ActiveRun, input: UserInput): void {
    // 切换 provider 后的第一条消息注入一次 handoff；事件读取要在 run.started 之前。
    const handoff = pendingHandoff(ctx, run.threadId)
    run.status = "running"
    runs.setStatus(run.runId, "running")
    append(run.threadId, run.runId, "run.started", {
      providerId: run.driver.id,
      providerSessionId: run.session.id,
    })
    activeRuns.set(run.runId, run)
    void execute(run, handoff === null ? input : { ...input, handoff })
  }

  /** 在并发空位出现时按 FIFO 启动排队 run。 */
  function pump(): void {
    while (activeRuns.size < maxConcurrentRuns) {
      const entry = queue.shift()
      if (!entry) return
      launchRun(entry.run, entry.input)
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

  /** 取消排队中的 run；不存在时返回 false。 */
  function cancelQueuedRun(runId: string): boolean {
    const entry = queue.remove((item) => item.run.runId === runId)
    if (!entry) return false
    const { run } = entry
    run.status = "interrupted"
    runs.setStatus(run.runId, "interrupted")
    append(run.threadId, run.runId, "run.interrupted", {})
    activeThreads.delete(run.threadId)
    run.resolveDone()
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
    for (const entry of [...queue.values()]) cancelQueuedRun(entry.run.runId)
    for (const runId of [...activeRuns.keys()]) interruptRun(runId)
  }

  const service: ProvidersService = {
    register(driver) {
      drivers.set(driver.id, driver)
    },
    unregister(driverId) {
      drivers.delete(driverId)
    },
    list() {
      return [...drivers.values()].map((driver) => ({
        id: driver.id,
        displayName: driver.displayName,
        capabilities: driver.capabilities,
      }))
    },
    async detect() {
      // Codex 与 Claude 都只做只读探测；fake 永远可用，保证离线也能开发。
      const [claude, codex] = await Promise.all([detectClaude(), detectCodex()])
      return { claude, codex, fake: { installed: true } }
    },
    async models(providerId) {
      return listProviderModels(drivers.get(providerId))
    },
    defaultProvider() {
      return defaultProvider((id) => drivers.has(id)) // 只接受已注册 driver。
    },
    async switchProvider(threadId, providerId, modelId) {
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
    async startRun(threadId, text, emitLive) {
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      if (activeThreads.has(threadId)) throw new RunAlreadyActiveError(threadId)
      // 切换后使用线程最近选择的 provider，未切换过时回退到创建时的默认值。
      const providerId = thread.lastProviderId ?? thread.defaultProviderId
      const driver = drivers.get(providerId)
      if (!driver) throw new Error(`provider not found: ${providerId}`)

      // activeThreads 同时覆盖运行中与排队中的线程，保证同一线程只有一个 run。
      activeThreads.add(threadId)
      try {
        const startedAt = new Date().toISOString()
        const activeSession = providerSessions.findActive(threadId, driver.id)
        const draft = await driver.createSession({
          threadId,
          cwd: resolveThreadCwd(ctx, thread.id, thread.projectId),
          nativeSessionId: activeSession?.nativeSessionId ?? null,
          permissionMode: thread.permissionMode,
          model: thread.lastModelId,
        })
        // 创建会话可能等待子进程，判定要放在 await 之后；此后到入队之间没有 await。
        const shouldQueue = activeRuns.size >= maxConcurrentRuns
        if (shouldQueue && queue.size >= maxQueuedRuns) {
          await driver.dispose(draft).catch(() => undefined)
          throw new RunQueueFullError(maxQueuedRuns)
        }
        const session = providerSessions.reuseOrCreate({
          draft,
          providerId: driver.id,
          createdAt: startedAt,
        })
        const runId = `run_${randomUUID()}`
        runs.create({
          id: runId,
          threadId,
          providerSessionId: session.id,
          status: shouldQueue ? "queued" : "running",
          startedAt,
        })
        append(threadId, runId, "message.completed", { role: "user", text })

        let resolveDone: () => void = () => undefined
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve
        })
        const run: ActiveRun = {
          runId,
          threadId,
          session,
          driver,
          controller: new AbortController(),
          emitLive,
          status: shouldQueue ? "queued" : "running",
          done,
          resolveDone,
          approvals: new Set(),
        }
        if (shouldQueue) {
          append(threadId, runId, "run.queued", { queuedAt: startedAt })
          queue.push({ run, input: { text }, queuedAt: startedAt })
          return { runId, done }
        }
        launchRun(run, { text })
        return { runId, done }
      } catch (error) {
        activeThreads.delete(threadId)
        throw error
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
          runId: entry.run.runId,
          threadId: entry.run.threadId,
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
      // 上一个 Host 进程退出后，未决审批、运行中的 run 与活跃会话都不再有效。
      const now = new Date().toISOString()
      const orphanedRequests = pendingRequests.orphanAll()
      const interruptedRuns = ctx.storage.db
        .prepare(
          `UPDATE runs SET status = 'interrupted', completed_at = ?
           WHERE status IN ('running', 'waiting-approval', 'queued')`,
        )
        .run(now).changes
      const orphanedSessions = providerSessions.orphanActive(now)
      return { orphanedRequests, interruptedRuns, orphanedSessions }
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
  })
}

apply.inject = inject
