/** Codex adapter：每 session 一个 app-server 子进程，经 NDJSON JSON-RPC 通信。 */
import type { AgentFeatures } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionInput,
  AgentDriver,
  AgentModelInfo,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  AgentStatus,
  UserInput,
} from "@pigcode/plugin-sdk"
import { CodexRpcClient } from "./client"
import { detectCodex, type CodexDetection } from "./detect"
import { codexLaunch, launchKey, type CodexLaunch } from "./launch"
import { FAST_SERVICE_TIER, parseCodexModels } from "./models"
import { HOST_VERSION } from "@pigcode/plugin-sdk"
import { normalizeCodexNotification } from "./normalize"
import {
  emitNotice,
  flushNotices,
  mcpStartupNotice,
  rememberNotice,
  type NoticeState,
} from "./notice"
import { StdioCodexTransport, type CodexTransport } from "./transport"

/** 单个 session 的 app-server 状态；权限与模型在 thread/start 或 thread/resume 时生效。 */
interface CodexSessionState {
  client: CodexRpcClient
  nativeThreadId: string | null
  turnId: string | null
  interruptRequested: boolean
  /** 本轮是否已经报过终态，用来忽略重复的 turn/completed。 */
  finished: boolean
  permissionMode: string
  model: string | null
  /** 启动这个 app-server 的命令指纹；设置改了就不再复用。 */
  launchKey: string
  /** 会话提示：MCP 桥起不来时攒下来，下一次 send 时补发。 */
  notice: NoticeState
  /** 上一轮用了快速模式；turn/start 的服务档会沿用到之后的轮次，关掉时要显式清回默认。 */
  fast?: boolean
}

/** driver 的可选依赖；测试替换传输与检测。 */
export interface CodexDriverOptions {
  transportFactory?: (launch: CodexLaunch) => CodexTransport
  detect?: (launch: CodexLaunch) => Promise<CodexDetection>
}

/** Codex 审批响应；Pigcode 只会产生这三种决议。 */
interface CodexApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline"
}

/** 基于 `codex app-server --stdio` 的 Codex driver。 */
export class CodexDriver implements AgentDriver {
  readonly id = "codex"
  readonly displayName = "Codex"
  // M2 桥接审批、计划、用量与 resume；M5 起通过 `config.mcp_servers` 注入插件工具。
  // fork 走 app-server 的 thread/fork（见 createSession），Host 切模型时已经在用，所以是 true。
  // questions/rollback/checkpoint/subagents 尚未实现，对应的 Agent 功能保持 false。
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: false,
    plan: true,
    resume: true,
    fork: true,
    rollback: false,
    checkpoint: false,
    subagents: false,
    mcp: true,
    images: false,
    usage: true,
    modelCatalog: true,
    nativeSessionId: true,
  }

  private readonly sessions = new Map<string, CodexSessionState>()
  /** 所有还开着的 app-server，包括 session 建到一半和临时拉模型目录的。 */
  private readonly clients = new Set<CodexRpcClient>()
  /** 正在结束的 app-server。注册表注销 driver 时不等 dispose，所以 close 要等这里的全部结束，否则 Host 一退出就没人强制结束它们了。 */
  private readonly ending = new Set<Promise<void>>()
  private readonly transportFactory: (launch: CodexLaunch) => CodexTransport
  private readonly probe: (launch: CodexLaunch) => Promise<CodexDetection>

  constructor(options: CodexDriverOptions = {}) {
    this.transportFactory =
      options.transportFactory ??
      ((launch) => new StdioCodexTransport(launch.command, launch.args, launch.env))
    this.probe =
      options.detect ?? ((launch) => detectCodex({ command: launch.command, env: launch.env }))
  }

  /** 只读检测：版本与登录状态，用设置页里的可执行文件与 CODEX_HOME。 */
  async detect(settings: AgentSettingsValues): Promise<AgentStatus> {
    const detection = await this.probe(codexLaunch(settings))
    return {
      installed: detection.installed,
      version: detection.version,
      authenticated: detection.installed ? detection.loggedIn : null,
      account: detection.account,
      command: detection.command,
      error: detection.error,
    }
  }

  /** 启动 app-server 并创建或恢复原生 thread。 */
  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    // 复用仍在运行的 app-server：同一原生 thread 的后续 run 不需要重新初始化。
    // 权限模式或模型变了就不复用，下面用 thread/resume 带上新的 sandbox 与审批策略。
    const permissionMode = input.permissionMode ?? "workspace-write"
    const model = input.model ?? null
    const launch = codexLaunch(input.settings)
    const key = launchKey(launch)
    const reusable = input.forkFromNativeSessionId
      ? undefined
      : input.nativeSessionId
        ? this.sessions.get(input.nativeSessionId)
        : undefined
    if (
      reusable?.nativeThreadId &&
      reusable.permissionMode === permissionMode &&
      reusable.model === model &&
      reusable.launchKey === key
    ) {
      return {
        id: input.sessionId ?? `codex_${randomUUID()}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: reusable.nativeThreadId,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    }

    const client = this.openClient(launch)
    // MCP 桥起不来时 app-server 只发一条通知，界面上否则没有任何线索（#57）。
    // 通知在 thread/start 之后就到，那时 run 还没开始，先攒在 session 里，等 send 时补发。
    const notice: NoticeState = { pending: [], told: new Set() }
    client.onNotification("mcpServer/startupStatus/updated", (params) => {
      const found = mcpStartupNotice(params)
      if (found) rememberNotice(notice, found)
    })
    try {
      await client.request("initialize", {
        clientInfo: { name: "pigcode", title: "Pigcode", version: HOST_VERSION },
      })
      const params = createThreadParams(input)
      // 同一 Agent 切换优先原生 fork；fork 返回的新 thread id 用于后续 turn。
      const forkFrom = input.forkFromNativeSessionId
      const response = forkFrom
        ? ((await client.request("thread/fork", {
            threadId: forkFrom,
            ...params,
          })) as { thread?: { id?: string } })
        : input.nativeSessionId
          ? ((await client.request("thread/resume", {
              threadId: input.nativeSessionId,
              ...params,
            })) as { thread?: { id?: string } })
          : ((await client.request("thread/start", params)) as { thread?: { id?: string } })
      const nativeThreadId =
        response.thread?.id ?? (forkFrom ? null : (input.nativeSessionId ?? null))
      const stateKey = nativeThreadId ?? input.threadId
      // 同一 key 的旧 state 必须先关闭，否则会遗留一个 app-server 子进程。
      const previous = this.sessions.get(stateKey)
      if (previous) {
        void this.closeClient(previous.client)
        this.sessions.delete(stateKey)
      }
      this.sessions.set(stateKey, {
        finished: false,
        client,
        nativeThreadId,
        turnId: null,
        interruptRequested: false,
        permissionMode,
        model,
        launchKey: key,
        notice,
      })
      return {
        id: input.sessionId ?? `codex_${randomUUID()}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: nativeThreadId,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    } catch (error) {
      // 初始化失败时结束子进程，避免泄漏 app-server。
      void this.closeClient(client)
      throw error
    }
  }

  /** 发起一个 turn，消费该 turn 的全部通知直到终态或中断。 */
  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime): Promise<void> {
    const state = this.stateFor(session)
    if (!state?.nativeThreadId) throw new Error("codex thread not started")
    const client = state.client
    state.interruptRequested = false
    state.finished = false
    // 启动期攒下的提示在这里补发：此刻 run 已经建立，事件有对应的 runId。
    flushNotices(state.notice, runtime)
    // 之后才到的启动结果直接推送，同样落在本轮；同一问题只报一次。
    const watchStartup = (params: unknown): void => {
      const found = mcpStartupNotice(params)
      if (found) emitNotice(state.notice, runtime, found)
    }
    const disposeStartup = client.onNotification("mcpServer/startupStatus/updated", watchStartup)

    const disposers = [
      client.onNotification("item/agentMessage/delta", (params) =>
        emit(runtime, "item/agentMessage/delta", params),
      ),
      client.onNotification("item/completed", (params) => emit(runtime, "item/completed", params)),
      client.onNotification("item/started", (params) => emit(runtime, "item/started", params)),
      client.onNotification("item/commandExecution/outputDelta", (params) =>
        emit(runtime, "item/commandExecution/outputDelta", params),
      ),
      client.onNotification("turn/plan/updated", (params) =>
        emit(runtime, "turn/plan/updated", params),
      ),
      client.onNotification("thread/tokenUsage/updated", (params) =>
        emit(runtime, "thread/tokenUsage/updated", params),
      ),
      client.onNotification("turn/completed", (params) => {
        const events = normalizeCodexNotification("turn/completed", params)
        const ends = events.some((event) => event.type.startsWith("run."))
        // app-server 可能重复通知同一个 turn 的终态；run 的终态只报一次。
        if (ends && state.finished) return
        if (ends) state.finished = true
        for (const event of events) runtime.emit(event)
      }),
    ]
    client.onServerRequest("item/commandExecution/requestApproval", async (params) => {
      const decision = await runtime.requestApproval({ toolName: "Bash", input: params })
      return toApprovalResponse(decision, "acceptForSession")
    })
    client.onServerRequest("item/fileChange/requestApproval", async (params) => {
      const decision = await runtime.requestApproval({ toolName: "ApplyPatch", input: params })
      return toApprovalResponse(decision, "acceptForSession")
    })
    client.onServerRequest("mcpServer/elicitation/request", async (params) => {
      const request = mcpToolApproval(params)
      // 审批卡片填不了表单，也打不开链接，这类请求只能拒绝。
      if (!request) return { action: "decline" }
      return toElicitationResponse(await runtime.requestApproval(request))
    })

    const text = input.handoff ? `${input.handoff}\n\n${input.text}` : input.text
    const onAbort = (): void => {
      void interruptTurn(state)
    }
    runtime.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const started = (await client.request("turn/start", {
        threadId: state.nativeThreadId,
        input: [{ type: "text", text }],
        // 思考深度只对本轮及之后的轮次生效；没有选择时沿用 Codex 的默认值。
        ...(input.effort ? { effort: input.effort } : {}),
        // 服务档和思考深度一样会沿用；选了快速发 fast，从快速切回标准时发 null 回到默认档。
        ...(input.fast
          ? { serviceTier: FAST_SERVICE_TIER }
          : state.fast
            ? { serviceTier: null }
            : {}),
      })) as { turn?: { id?: string } }
      state.fast = input.fast === true
      state.turnId = started.turn?.id ?? null
      if (runtime.signal.aborted) {
        // abort 可能早于 turn/start 响应；此时才能拿到 turnId 并发送中断。
        void interruptTurn(state)
        return
      }
      await waitForTurn(client, state.turnId, runtime.signal)
    } finally {
      runtime.signal.removeEventListener("abort", onAbort)
      disposeStartup()
      for (const dispose of disposers) dispose()
      state.turnId = null
    }
  }

  /** 临时启动 app-server 拉取模型目录；失败时返回空目录，不影响设置页。 */
  async listModels(settings: AgentSettingsValues = {}): Promise<AgentModelInfo[]> {
    const client = this.openClient(codexLaunch(settings))
    try {
      await client.request("initialize", {
        clientInfo: { name: "pigcode", title: "Pigcode", version: HOST_VERSION },
      })
      return parseCodexModels(await client.request("model/list", {}))
    } catch {
      return []
    } finally {
      void this.closeClient(client)
    }
  }

  /** 中断该 session 当前活跃的 turn；没有活跃 turn 时为空操作。 */
  async interrupt(session: AgentSessionHandle): Promise<void> {
    const state = this.stateFor(session)
    if (!state) return
    await interruptTurn(state)
  }

  /** 关闭 app-server 并释放 session 状态。 */
  async dispose(session: AgentSessionHandle): Promise<void> {
    const keys = [session.nativeSessionId, session.threadId].filter((value): value is string =>
      Boolean(value),
    )
    for (const key of keys) {
      const state = this.sessions.get(key)
      if (!state) continue
      this.sessions.delete(key)
      await this.closeClient(state.client)
    }
  }

  /** 插件停用时关闭所有 app-server，包括空闲等待复用的。 */
  async close(): Promise<void> {
    this.sessions.clear()
    for (const client of [...this.clients]) void this.closeClient(client)
    await Promise.all(this.ending)
  }

  /** 启动一个 app-server 并记下来，插件停用时都要结束。 */
  private openClient(launch: CodexLaunch): CodexRpcClient {
    const client = new CodexRpcClient(this.transportFactory(launch))
    this.clients.add(client)
    return client
  }

  /** 结束 app-server；不管调用方等不等，close 都会等它结束。 */
  private closeClient(client: CodexRpcClient): Promise<void> {
    this.clients.delete(client)
    const done = client.close().finally(() => {
      this.ending.delete(done)
    })
    this.ending.add(done)
    return done
  }

  /** 按原生 thread id 或本地 thread id 查找 session 状态。 */
  private stateFor(session: AgentSessionHandle): CodexSessionState | undefined {
    return this.sessions.get(session.nativeSessionId ?? session.threadId)
  }
}

/** 构造 thread/start 或 thread/resume 的共享参数。 */
function createThreadParams(input: CreateSessionInput): Record<string, unknown> {
  const permissionMode = input.permissionMode ?? "workspace-write"
  const sandbox =
    permissionMode === "read-only"
      ? "read-only"
      : permissionMode === "danger-full-access"
        ? "danger-full-access"
        : "workspace-write"
  const model = input.model ?? process.env.PIGCODE_CODEX_MODEL
  return {
    cwd: input.cwd,
    approvalPolicy: permissionMode === "danger-full-access" ? "never" : "on-request",
    sandbox,
    ...(model ? { model } : {}),
    // 插件工具经 stdio 桥接入：app-server 按 config.mcp_servers 启动桥进程。
    ...(input.mcp ? { config: { mcp_servers: { pigcode: input.mcp.stdioServer() } } } : {}),
  }
}

/** 把通知映射后逐条交给 run 的实时事件出口。 */
function emit(runtime: AgentRuntime, method: string, params: unknown): void {
  for (const event of normalizeCodexNotification(method, params)) runtime.emit(event)
}

/** 发送一次 turn/interrupt；同一 turn 只发送一次。 */
async function interruptTurn(state: CodexSessionState): Promise<void> {
  if (state.interruptRequested || !state.nativeThreadId || !state.turnId) return
  state.interruptRequested = true
  try {
    await state.client.request("turn/interrupt", {
      threadId: state.nativeThreadId,
      turnId: state.turnId,
    })
  } catch {
    // 服务端可能已结束该 turn；中断失败不阻塞 run 的终态处理。
  }
}

/** 等待匹配 turnId 的 turn/completed，或等待 run 的取消信号。 */
function waitForTurn(
  client: CodexRpcClient,
  turnId: string | null,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let dispose: () => void = () => undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      dispose()
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const disposeCompleted = client.onNotification("turn/completed", (params) => {
      const completed = completedTurnId(params)
      if (turnId && completed && completed !== turnId) return
      finish()
    })
    // app-server 中途退出时这一轮不会再有 turn/completed；以失败结束，而不是一直等。
    const disposeClose = client.onClose((reason) => {
      if (settled) return
      settled = true
      dispose()
      signal.removeEventListener("abort", finish)
      reject(reason)
    })
    dispose = () => {
      disposeCompleted()
      disposeClose()
    }
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** 从 turn/completed 的 params 中读取 turn id。 */
function completedTurnId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined
  const record = params as Record<string, unknown>
  const turn = record.turn
  if (typeof turn === "object" && turn !== null) {
    const id = (turn as Record<string, unknown>).id
    if (typeof id === "string") return id
  }
  return typeof record.turnId === "string" ? record.turnId : undefined
}

/**
 * Codex 用 MCP elicitation 请求批准工具调用，靠 `_meta.codex_approval_kind` 和普通的 elicitation 区分。
 * 请求里没有单独的工具名字段，只能从 message 里取；取不到时退回到 server 名。
 */
function mcpToolApproval(params: unknown): ApprovalRequest | null {
  const record = params as {
    serverName?: unknown
    message?: unknown
    _meta?: { codex_approval_kind?: unknown; tool_description?: unknown; tool_params?: unknown }
  }
  const server = record.serverName
  if (record._meta?.codex_approval_kind !== "mcp_tool_call" || typeof server !== "string") {
    return null
  }
  const tool =
    typeof record.message === "string" ? /tool "([^"]+)"/.exec(record.message)?.[1] : null
  const description = record._meta.tool_description
  return {
    toolName: tool ? `mcp__${server}__${tool}` : `mcp__${server}`,
    input: record._meta.tool_params ?? {},
    ...(typeof description === "string" ? { description } : {}),
  }
}

/** 把 Pigcode 审批决议映射为 MCP elicitation 的答复；本会话内放行靠 `_meta.persist`。 */
function toElicitationResponse(decision: ApprovalDecision): Record<string, unknown> {
  if (decision === "deny") return { action: "decline" }
  if (decision === "allow-for-session") {
    return { action: "accept", content: {}, _meta: { persist: "session" } }
  }
  return { action: "accept", content: {} }
}

/** 把 Pigcode 审批决议映射为 Codex 的 accept/acceptForSession/decline。 */
function toApprovalResponse(
  decision: ApprovalDecision,
  sessionDecision: "acceptForSession",
): CodexApprovalResponse {
  if (decision === "deny") return { decision: "decline" }
  if (decision === "allow-for-session") return { decision: sessionDecision }
  return { decision: "accept" }
}
