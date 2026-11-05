/** Codex adapter：每 session 一个 app-server 子进程，经 NDJSON JSON-RPC 通信。 */
import type { AgentFeatures } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
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
import { parseCodexModels } from "./models"
import { normalizeCodexNotification } from "./normalize"
import { StdioCodexTransport, type CodexTransport } from "./transport"

/** 单个 session 的 app-server 状态；权限与模型在 thread/start 或 thread/resume 时生效。 */
interface CodexSessionState {
  client: CodexRpcClient
  nativeThreadId: string | null
  turnId: string | null
  interruptRequested: boolean
  permissionMode: string
  model: string | null
  /** 启动这个 app-server 的命令指纹；设置改了就不再复用。 */
  launchKey: string
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
  // questions/fork/rollback/checkpoint/subagents 尚未实现，对应的 Agent 功能保持 false。
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: false,
    plan: true,
    resume: true,
    fork: false,
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
    try {
      await client.request("initialize", {
        clientInfo: { name: "pigcode", title: "Pigcode", version: "0.1.0" },
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
        client,
        nativeThreadId,
        turnId: null,
        interruptRequested: false,
        permissionMode,
        model,
        launchKey: key,
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
      client.onNotification("turn/completed", (params) => emit(runtime, "turn/completed", params)),
    ]
    client.onServerRequest("item/commandExecution/requestApproval", async (params) => {
      const decision = await runtime.requestApproval({ toolName: "Bash", input: params })
      return toApprovalResponse(decision, "acceptForSession")
    })
    client.onServerRequest("item/fileChange/requestApproval", async (params) => {
      const decision = await runtime.requestApproval({ toolName: "ApplyPatch", input: params })
      return toApprovalResponse(decision, "acceptForSession")
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
      })) as { turn?: { id?: string } }
      state.turnId = started.turn?.id ?? null
      if (runtime.signal.aborted) {
        // abort 可能早于 turn/start 响应；此时才能拿到 turnId 并发送中断。
        void interruptTurn(state)
        return
      }
      await waitForTurn(client, state.turnId, runtime.signal)
    } finally {
      runtime.signal.removeEventListener("abort", onAbort)
      for (const dispose of disposers) dispose()
      state.turnId = null
    }
  }

  /** 临时启动 app-server 拉取模型目录；失败时返回空目录，不影响设置页。 */
  async listModels(settings: AgentSettingsValues = {}): Promise<AgentModelInfo[]> {
    const client = this.openClient(codexLaunch(settings))
    try {
      await client.request("initialize", {
        clientInfo: { name: "pigcode", title: "Pigcode", version: "0.1.0" },
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

/** 把 Pigcode 审批决议映射为 Codex 的 accept/acceptForSession/decline。 */
function toApprovalResponse(
  decision: ApprovalDecision,
  sessionDecision: "acceptForSession",
): CodexApprovalResponse {
  if (decision === "deny") return { decision: "decline" }
  if (decision === "allow-for-session") return { decision: sessionDecision }
  return { decision: "accept" }
}
