/** 注册 Agent driver，并把一次 run 的规范化事件映射为线程事件。 */
import { modesOf, modesForSwitch, resolveModes, registeredAgents } from "./execution-modes"
import type { Context } from "cordis"
import type { Thread, ThreadEvent } from "@pigcode/contracts"
import type { AgentRunConfig, AgentDriver } from "./driver"
import { FakeAgentDriver } from "./fake"
import { createAgentCatalog } from "./agent-catalog"
import { assertNoStoredInstanceId, forcedAgentId, readStoredInstances } from "./agent-settings"
import {
  RunAlreadyActiveError,
  RunQueueFullError,
  RunSelectionUnavailableError,
  TooManyActiveRunsError,
} from "./errors"
import { envCount, RunQueue, type ActiveRun, type QueuedRun } from "./run-queue"
import { MessageQueue } from "./message-queue"
import { launchRun, type LaunchDeps } from "./run-launch"
import { recoverAfterRestart } from "./restart"
import { prepareRunEntry, writeRunAdmission } from "./run-admission"
import { createRunFinisher } from "./run-finish"
import { createRunRequestResponder } from "./run-requests"
import type { RunEventHooks } from "./run-events"
import { disposeSession, switchAgent } from "./switching"
import { createExecute, trackRunExecution } from "./run-execute"
import { THREAD_ACTIVITY } from "../services/threads"
import { appendThreadCreated } from "../services/thread-create"
import { createCliUpdates } from "./cli-updates"
import { ApprovalBridge, createApprovalRequest } from "./approval-bridge"
import { AgentSessionStore } from "./session-store"
import { PendingRequestStore } from "../storage/pending-request-store"
import { RunStore } from "../storage/run-store"
import { catalogOperations, type AgentsService, type StartRunOptions } from "./service"
import { createQuestionFlow } from "./questions"
import { watchClaudeIdleCompaction } from "./idle-compaction"
import { createInstanceSetup } from "./instance-setup"

export type { ApprovalHandle, AgentsService, StartRunOptions, StartRunResult } from "./service"
declare module "cordis" {
  interface Context {
    agents: AgentsService
  }
}
/** agents 插件依赖的线程、事件与存储服务。 */
export const inject = ["threads", "sessions", "storage", "projects"]
export { RunAlreadyActiveError, TooManyActiveRunsError, RunQueueFullError }

/** 注册 Agent driver，并把一次 run 的规范化事件映射为线程事件。 */
export function apply(ctx: Context, config: AgentRunConfig = {}): void {
  // E2E 用 PIGCODE_MAX_CONCURRENT_RUNS 把并发压到 1，好观察排队中的会话。
  const maxConcurrentRuns = envCount("PIGCODE_MAX_CONCURRENT_RUNS") ?? config.maxConcurrentRuns ?? 4
  const maxQueuedRuns = config.maxQueuedRuns ?? 32
  const drivers = new Map<string, AgentDriver>()
  if (config.fake !== false || forcedAgentId() === "fake") {
    const fake = new FakeAgentDriver({
      callTool: (threadId, name, input) => {
        const bridge = ctx.reflect.get("mcpBridge")
        if (!bridge) return Promise.reject(new Error("MCP tools are not available"))
        return bridge.callTool(threadId, name, input)
      },
    })
    drivers.set(fake.id, fake)
  }
  const agents = createAgentCatalog(ctx, drivers, config.dataDir)
  const runs = new RunStore(ctx.storage.db)
  const pendingRequests = new PendingRequestStore(ctx.storage.db)
  const agentSessions = new AgentSessionStore(ctx.storage.db)
  const approvals = new ApprovalBridge()
  const activeRuns = new Map<string, ActiveRun>()
  const activeThreads = new Set<string>()
  const queue = new RunQueue<QueuedRun>(maxQueuedRuns)
  /** 正在异步创建 Agent 会话的 run 数；用于避免并发空位被重复占用。 */
  let launching = 0
  const starting = new Map<string, QueuedRun>()
  /** 追加一条线程事件并触发订阅者；run 开始和结束时先推进会话的更新时间，订阅者读到的是新的。 */
  function append(
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ): void {
    const createdAt = new Date().toISOString()
    if (THREAD_ACTIVITY.has(type)) ctx.threads.touch(threadId, createdAt, runId)
    ctx.get("messageQueue")?.onRunEvent(threadId, runId, type)
    ctx.sessions.append({ threadId, runId, type, payload, schemaVersion: 1, createdAt })
  }

  const questions = createQuestionFlow({ append, pendingRequests, runs, activeRuns })
  const respondToRequest = createRunRequestResponder({
    ctx,
    runs,
    activeRuns,
    pendingRequests,
    approvals,
    questions,
    append,
  })
  const finishRun = createRunFinisher({
    ctx,
    runs,
    pendingRequests,
    activeRuns,
    activeThreads,
    append,
    releaseRequest: ({ id, kind }) => {
      if (kind === "question") questions.resolve(id, [])
      else approvals.resolve(id, "deny")
    },
    pump,
  })

  /** Agent 事件映射所需的 Host 回调。 */
  const runEventHooks: RunEventHooks = {
    isActive: (run) => activeRuns.get(run.runId) === run,
    publishLive: (run, event) => ctx.sessions.emitLive(run.threadId, run.runId, event),
    append,
    updateNativeSessionId: (sessionId, nativeSessionId) =>
      agentSessions.updateNativeSessionId(sessionId, nativeSessionId),
    finish: finishRun,
  }

  const requestApproval = createApprovalRequest(
    ctx.storage.db,
    approvals,
    pendingRequests,
    runs,
    activeRuns,
    append,
  )

  /** 在并发空位出现时按 FIFO 启动排队 run；launching 计入正在创建会话的 run。 */
  function pump(): void {
    while (activeRuns.size + launching < maxConcurrentRuns) {
      const entry = queue.shift()
      if (!entry) return
      launching += 1
      void launch(entry).finally(() => {
        launching -= 1
        pump()
      })
    }
  }

  const execution = trackRunExecution(
    ctx,
    createExecute({
      ctx,
      activeRuns,
      hooks: runEventHooks,
      requestApproval: (run, request) => requestApproval(run.threadId, run.runId, request).decision,
      askQuestions: questions.ask,
    }),
  )

  /** launchRun 所需的 Host 闭包；放在 execute 之后以便引用。 */
  const launchDeps: LaunchDeps = {
    ctx,
    agentSessions,
    runs,
    activeRuns,
    activeThreads,
    append,
    execute: execution.execute,
    settingsFor: agents.runtimeSettings,
    instanceContext: (agentId, instanceId) =>
      drivers.get(agentId)?.accountSetup || drivers.get(agentId)?.requiresInstance
        ? agents.instanceContext(agents.instance(agentId, instanceId))
        : undefined,
  }

  async function launch(entry: QueuedRun): Promise<void> {
    starting.set(entry.runId, entry)
    try {
      await launchRun(entry, launchDeps)
    } finally {
      starting.delete(entry.runId)
      ctx.get("messageQueue")?.schedule(entry.threadId)
    }
  }

  /** 取消排队中的 run；此时尚未创建 Agent 会话，只需写终态并释放线程。 */
  function cancelQueuedRun(runId: string, recordReceipt?: () => void): boolean {
    const entry = queue.values().find((item) => item.runId === runId)
    if (!entry) return false
    const publish = persistUnstartedStop(entry, recordReceipt)
    queue.remove((item) => item.runId === runId)
    activeThreads.delete(entry.threadId)
    publish()
    entry.resolveDone()
    return true
  }

  function persistUnstartedStop(entry: QueuedRun, recordReceipt?: () => void): () => void {
    return ctx.sessions.stageEvents(() => {
      recordReceipt?.()
      if (runs.get(entry.runId)?.status === "interrupted") return
      runs.setStatus(entry.runId, "interrupted")
      append(entry.threadId, entry.runId, "run.interrupted", {})
    })
  }

  /** 中断单个活跃或排队中的 run；未知 run 返回 false。 */
  function interruptRun(runId: string, recordReceipt?: () => void): boolean {
    if (cancelQueuedRun(runId, recordReceipt)) return true
    const launching = starting.get(runId)
    if (launching && !activeRuns.has(runId)) {
      const publish = persistUnstartedStop(launching, recordReceipt)
      launching.controller.abort()
      publish()
      return true
    }
    const run = activeRuns.get(runId)
    if (!run) return false
    finishRun(run, "interrupted", "run.interrupted", {}, undefined, recordReceipt)
    return true
  }

  function interruptAll(): void {
    for (const entry of [...queue.values()]) cancelQueuedRun(entry.runId)
    for (const runId of starting.keys()) interruptRun(runId)
    for (const runId of [...activeRuns.keys()]) interruptRun(runId)
  }

  async function stopInstanceRuns(instanceId: string): Promise<void> {
    for (const entry of queue.values()) {
      if (entry.instanceId === instanceId) cancelQueuedRun(entry.runId)
    }
    const pending = [...starting.values()].filter((entry) => entry.instanceId === instanceId)
    for (const entry of pending) interruptRun(entry.runId)
    for (const run of [...activeRuns.values()]) {
      if (run.instanceId === instanceId) interruptRun(run.runId)
    }
    await Promise.all(pending.map((entry) => entry.done))
  }

  /** 注销 driver 时取消排队任务，中断活跃任务并释放会话进程。 */
  function unregisterDriver(driverId: string): void {
    const driver = drivers.get(driverId)
    if (!driver) return
    for (const entry of queue.values()) {
      if (entry.driver === driver) cancelQueuedRun(entry.runId)
    }
    for (const entry of starting.values()) {
      if (entry.driver === driver) interruptRun(entry.runId)
    }
    for (const run of [...activeRuns.values()]) {
      if (run.driver !== driver) continue
      interruptRun(run.runId)
      void driver.dispose(run.session).catch(() => undefined)
    }
    drivers.delete(driverId)
    // 这个 agent 的所有实例的检测与模型目录都重新读取。
    for (const instance of agents.instances(driverId)) agents.invalidate(instance.instanceId)
    agents.invalidate(driverId)
  }

  const cliUpdates = createCliUpdates(drivers, agents, (id) =>
    ctx.threads
      .list()
      .some(
        (thread) =>
          activeThreads.has(thread.id) && (thread.lastAgentId ?? thread.defaultAgentId) === id,
      ),
  )
  const setup = createInstanceSetup(ctx, agents, drivers, stopInstanceRuns, cliUpdates.check)

  function prepare(
    thread: Thread,
    text: string,
    emitLive: QueuedRun["emitLive"],
    options: StartRunOptions,
  ) {
    if (activeThreads.has(thread.id)) throw new RunAlreadyActiveError(thread.id)
    const agentId = thread.lastAgentId ?? thread.defaultAgentId
    if (cliUpdates.isUpdating(agentId))
      throw new RunSelectionUnavailableError(
        "CLI update in progress. Please try again after it finishes.",
      )
    const driver = drivers.get(agentId)
    if (!driver) throw new RunSelectionUnavailableError(`agent not found: ${agentId}`)
    const instance = agents.instance(
      agentId,
      options.instanceId ?? thread.lastInstanceId ?? thread.defaultInstanceId,
    )
    if (!instance.enabled)
      throw new RunSelectionUnavailableError(`instance is disabled: ${instance.instanceId}`)
    if (setup.isStopping(instance.instanceId))
      throw new RunSelectionUnavailableError("Agent instance is stopping")
    const modes = resolveModes(modesOf(driver, agents.instanceContext(instance)), thread, agentId)
    const queued = activeRuns.size + launching >= maxConcurrentRuns
    if (queued && queue.size >= maxQueuedRuns) throw new RunQueueFullError(maxQueuedRuns)
    const entry = prepareRunEntry(ctx, agentSessions, {
      thread,
      driver,
      instanceId: instance.instanceId,
      modes,
      text,
      emitLive,
      options,
    })
    return { entry, queued }
  }

  async function startPrepared(
    { entry, queued }: ReturnType<typeof prepare>,
    persist: () => () => void,
  ) {
    const { runId, threadId, done } = entry
    activeThreads.add(threadId)
    if (!queued) launching += 1
    try {
      const publish = persist()
      if (queued) {
        if (!queue.push(entry)) throw new RunQueueFullError(maxQueuedRuns)
        publish()
        return { runId, done }
      }
      const launched = launch(entry)
      publish()
      await launched
      return { runId, done }
    } catch (error) {
      activeThreads.delete(threadId)
      throw error
    } finally {
      if (!queued) {
        launching -= 1
        pump()
      }
    }
  }

  const service: AgentsService = {
    ...catalogOperations(agents),
    cliUpdates: cliUpdates.list,
    checkCliUpdates: cliUpdates.check,
    updateCli: cliUpdates.update,
    cancelCliUpdate: cliUpdates.cancel,
    auth: setup.auth,
    removeCli: setup.removeCli,
    register(driver) {
      modesOf(driver)
      const stored = readStoredInstances(ctx.get("settings"))
      if (!driver.requiresInstance || stored[driver.id]?.agentId !== driver.id)
        assertNoStoredInstanceId(stored, driver.id)
      drivers.set(driver.id, driver)
      agents.invalidate(driver.id)
    },
    unregister: unregisterDriver,
    list: () => registeredAgents(drivers),
    defaultAgent: () => agents.defaultAgent(),
    setDefaultAgent: (agentId, instanceId) => agents.setDefaultAgent(agentId, instanceId ?? null),
    updateInstance: setup.updateInstance,
    removeInstance: setup.removeInstance,
    async switchAgent(threadId, agentId, modelId, instanceId) {
      // 运行中或排队中的线程不能切换：否则旧会话被 dispose，正在跑的 run 会失去驱动。
      if (activeThreads.has(threadId)) throw new RunAlreadyActiveError(threadId)
      if (!drivers.has(agentId)) throw new Error(`agent not found: ${agentId}`)
      const instance = agents.instance(agentId, instanceId)
      if (!instance.enabled) throw new Error(`instance is disabled: ${instance.instanceId}`)
      return switchAgent(
        ctx,
        agentSessions,
        threadId,
        agentId,
        modelId ?? null,
        (session) => disposeSession(drivers, session),
        instance.instanceId,
        async (id) =>
          drivers.get(agentId)?.continuationKey?.(await agents.runtimeSettings(agentId, id)) ??
          null,
        modesForSwitch(ctx, threadId, agentId, instance.instanceId),
        drivers.get(agentId)?.modelSwitch,
      )
    },
    async startRun(threadId, text, emitLive, options = {}) {
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      const prepared = prepare(thread, text, emitLive, options)
      return startPrepared(prepared, () => {
        const write = () =>
          writeRunAdmission(ctx, runs, thread, prepared.entry, prepared.queued, options, append)
        if (options.admission) return ctx.sessions.stageEvents(write)
        write()
        return () => undefined
      })
    },
    async startDraftRun(selection, text, mobileAdmission) {
      const options = { admission: mobileAdmission }
      let prepared!: ReturnType<typeof prepare>
      const publish = ctx.sessions.stageEvents(() => {
        const { threadId: id, projectId, agentId, modelId, ...initial } = selection
        if (
          !agents
            .instances(agentId)
            .some(({ instanceId, enabled }) => enabled && instanceId === initial.instanceId)
        ) {
          throw new RunSelectionUnavailableError(`instance is unavailable: ${initial.instanceId}`)
        }
        const thread = ctx.threads.create(projectId, "新会话", agentId, undefined, {
          id,
          ...initial,
          modelId: modelId ?? undefined,
        })
        appendThreadCreated(ctx, thread)
        prepared = prepare(thread, text, undefined, options)
        writeRunAdmission(ctx, runs, thread, prepared.entry, prepared.queued, options, append)
      })
      return startPrepared(prepared, () => publish)
    },
    requestApproval(threadId, runId, request) {
      return requestApproval(threadId, runId, request)
    },
    respondApproval(threadId, runId, requestId, decision, options) {
      return respondToRequest(
        { threadId, runId, requestId },
        { kind: "approval", decision },
        options,
      )
    },
    answerQuestion(threadId, runId, requestId, answers, options) {
      return respondToRequest(
        { threadId, runId, requestId },
        { kind: "question", answers },
        options,
      )
    },
    getRunStatus(runId) {
      const active = activeRuns.get(runId)
      if (active) return active.status
      return runs.get(runId)?.status ?? null
    },
    cancelRun(runId, recordReceipt) {
      return interruptRun(runId, recordReceipt)
    },
    cancelDeviceQueuedRuns(deviceKey) {
      for (const entry of [...queue.values(), ...starting.values()]) {
        if (activeRuns.has(entry.runId)) continue
        if (entry.sourceDevice !== deviceKey && entry.isAuthorized?.() !== false) continue
        entry.controller.abort()
        try {
          interruptRun(entry.runId)
        } catch (error) {
          console.error("[host] could not record revoked run interruption", error)
        }
      }
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
      return agentSessions.listByThread(threadId)
    },
    listPendingRequests(threadId) {
      return pendingRequests.listPending(threadId)
    },
    recoverAfterRestart() {
      return recoverAfterRestart(ctx, pendingRequests, agentSessions, append)
    },
  }

  ctx.provide("agents", service)
  const messages = new MessageQueue(ctx, {
    idle: (threadId) => !activeThreads.has(threadId) && !execution.busy(threadId),
    currentRun: (threadId) =>
      [...activeRuns.values(), ...starting.values(), ...queue.values()].find(
        (entry) => entry.threadId === threadId && !entry.controller.signal.aborted,
      )?.runId,
  })
  ctx.provide("messageQueue", messages)
  const canCompact = () => activeRuns.size + launching < maxConcurrentRuns && !queue.size
  ctx.effect(() => watchClaudeIdleCompaction(ctx, canCompact))
  ctx.effect(() => () => {
    messages.dispose()
    cliUpdates.dispose()
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
