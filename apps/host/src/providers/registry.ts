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
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "./driver"
import { FakeProviderDriver } from "./fake"
import { detectClaude } from "./claude/detect"
import type { ClaudeDetection } from "./claude/detect"
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
  list(): Array<{ id: string; displayName: string; capabilities: ProviderCapabilities }>
  detect(): Promise<{ claude: ClaudeDetection; fake: { installed: true } }>
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

/** 同一 thread 已有活跃 run 时抛出的错误。 */
export class RunAlreadyActiveError extends Error {
  readonly code = "RUN_ALREADY_ACTIVE"

  constructor(threadId: string) {
    super(`RUN_ALREADY_ACTIVE: thread ${threadId} already has an active run`)
    this.name = "RunAlreadyActiveError"
  }
}

/** 运行期内存状态；终态事件到达后从 activeRuns 移除。 */
interface ActiveRun {
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

/** 注册 fake provider 并提供 run 生命周期服务。 */
export function apply(ctx: Context): void {
  const drivers = new Map<string, ProviderDriver>()
  const fake = new FakeProviderDriver()
  drivers.set(fake.id, fake)

  const runs = new RunStore(ctx.storage.db)
  const pendingRequests = new PendingRequestStore(ctx.storage.db)
  const providerSessions = new ProviderSessionStore(ctx.storage.db)
  const approvals = new ApprovalBridge()
  const activeRuns = new Map<string, ActiveRun>()
  const activeThreads = new Set<string>()

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

  /** provider 回报原生会话 id 后更新会话行。 */
  function updateSessionNativeId(sessionId: string, nativeSessionId: string): void {
    providerSessions.updateNativeSessionId(sessionId, nativeSessionId)
  }

  /** 把 provider 事件映射为持久线程事件；delta 只走实时通道。 */
  function handleProviderEvent(run: ActiveRun, event: ProviderEvent): void {
    if (activeRuns.get(run.runId) !== run) return
    switch (event.type) {
      case "run.started":
        return
      case "session.started":
        run.session.nativeSessionId = event.nativeSessionId
        updateSessionNativeId(run.session.id, event.nativeSessionId)
        append(run.threadId, run.runId, "session.started", {
          nativeSessionId: event.nativeSessionId,
        })
        return
      case "message.delta":
        run.emitLive?.(event)
        return
      case "message.completed":
        append(run.threadId, run.runId, "message.completed", {
          role: "assistant",
          text: event.text,
        })
        return
      case "tool.started":
        append(run.threadId, run.runId, "tool.started", {
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
        })
        return
      case "tool.completed":
        append(run.threadId, run.runId, "tool.completed", {
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          name: event.name,
          output: event.output,
          isError: event.isError,
          status: event.isError ? "failed" : "completed",
        })
        return
      case "usage.updated":
        append(run.threadId, run.runId, "usage.updated", { usage: event.usage })
        return
      case "run.completed":
        finishRun(run, "completed", "run.completed", {})
        return
      case "run.failed":
        finishRun(
          run,
          "failed",
          "run.failed",
          { message: event.message },
          {
            code: "RUN_FAILED",
            message: event.message,
          },
        )
    }
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

  /** 异步执行 driver.send；异常统一转成 run.failed。 */
  async function execute(run: ActiveRun, input: UserInput): Promise<void> {
    const runtime: ProviderRuntime = {
      signal: run.controller.signal,
      emit: (event) => handleProviderEvent(run, event),
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

  const service: ProvidersService = {
    register(driver) {
      drivers.set(driver.id, driver)
    },
    list() {
      return [...drivers.values()].map((driver) => ({
        id: driver.id,
        displayName: driver.displayName,
        capabilities: driver.capabilities,
      }))
    },
    async detect() {
      // Claude 只做只读探测；fake 永远可用，保证离线也能开发。
      const claude = await detectClaude()
      return { claude, fake: { installed: true } }
    },
    async startRun(threadId, text, emitLive) {
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      if (activeThreads.has(threadId)) throw new RunAlreadyActiveError(threadId)
      const driver = drivers.get(thread.defaultProviderId)
      if (!driver) throw new Error(`provider not found: ${thread.defaultProviderId}`)

      activeThreads.add(threadId)
      try {
        const startedAt = new Date().toISOString()
        const activeSession = providerSessions.findActive(threadId, driver.id)
        const draft = await driver.createSession({
          threadId,
          cwd: resolveCwd(ctx, thread.projectId),
          nativeSessionId: activeSession?.nativeSessionId ?? null,
          permissionMode: thread.permissionMode,
          model: thread.lastModelId,
        })
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
          status: "running",
          startedAt,
        })

        append(threadId, runId, "message.completed", { role: "user", text })
        append(threadId, runId, "run.started", {
          providerId: driver.id,
          providerSessionId: session.id,
        })

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
          status: "running",
          done,
          resolveDone,
          approvals: new Set(),
        }
        activeRuns.set(runId, run)
        void execute(run, { text })
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
      const run = activeRuns.get(runId)
      if (!run) return false
      run.controller.abort()
      void run.driver.interrupt(run.session).catch(() => undefined)
      finishRun(run, "interrupted", "run.interrupted", {})
      return true
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
           WHERE status IN ('running', 'waiting-approval')`,
        )
        .run(now).changes
      const orphanedSessions = providerSessions.orphanActive(now)
      return { orphanedRequests, interruptedRuns, orphanedSessions }
    },
  }

  ctx.provide("providers", service)
  ctx.effect(() => () => {
    for (const run of activeRuns.values()) {
      run.controller.abort()
      run.resolveDone()
    }
    activeRuns.clear()
    activeThreads.clear()
    approvals.rejectAll(new Error("host disposed"))
  })
}

apply.inject = inject

/** 读取线程所属项目的根目录作为 provider cwd。 */
function resolveCwd(ctx: Context, projectId: string): string {
  const row = ctx.storage.db
    .prepare(`SELECT root_path FROM projects WHERE id = ?`)
    .get(projectId) as { root_path: string } | undefined
  return row?.root_path ?? process.cwd()
}
