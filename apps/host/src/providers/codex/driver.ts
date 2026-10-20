/** Codex adapter：每 session 一个 app-server 子进程，经 NDJSON JSON-RPC 通信。 */
import type { ProviderCapabilities } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
  CreateSessionInput,
  ProviderDriver,
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "../driver"
import { CodexRpcClient } from "./client"
import { normalizeCodexNotification } from "./normalize"
import { StdioCodexTransport, type CodexTransport } from "./transport"

/** Codex 的用户输入；handoff 是切换 provider 时注入的上下文。 */
export interface CodexUserInput extends UserInput {
  handoff?: string
}

/** 单个 session 的 app-server 状态。 */
interface CodexSessionState {
  client: CodexRpcClient
  nativeThreadId: string | null
  turnId: string | null
  interruptRequested: boolean
}

/** Codex 审批响应；Pigcode 只会产生这三种决议。 */
interface CodexApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline"
}

/** 基于 `codex app-server --stdio` 的 Codex provider。 */
export class CodexDriver implements ProviderDriver {
  readonly id = "codex"
  readonly displayName = "Codex"
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    questions: false,
    plan: true,
    resume: true,
    fork: false,
    rollback: false,
    checkpoint: false,
    subagents: false,
    mcp: false,
    images: false,
    usage: true,
    modelCatalog: true,
    nativeSessionId: true,
  }

  private readonly sessions = new Map<string, CodexSessionState>()
  private readonly transportFactory: (() => CodexTransport) | undefined

  constructor(options: { transportFactory?: () => CodexTransport } = {}) {
    this.transportFactory = options.transportFactory
  }

  /** 启动 app-server 并创建或恢复原生 thread。 */
  async createSession(input: CreateSessionInput): Promise<ProviderSessionHandle> {
    const transport = this.transportFactory?.() ?? new StdioCodexTransport()
    const client = new CodexRpcClient(transport)
    try {
      await client.request("initialize", {
        clientInfo: { name: "pigcode", title: "Pigcode", version: "0.1.0" },
      })
      const params = createThreadParams(input)
      const response = input.nativeSessionId
        ? ((await client.request("thread/resume", {
            threadId: input.nativeSessionId,
            ...params,
          })) as { thread?: { id?: string } })
        : ((await client.request("thread/start", params)) as { thread?: { id?: string } })
      const nativeThreadId = response.thread?.id ?? input.nativeSessionId ?? null
      this.sessions.set(nativeThreadId ?? input.threadId, {
        client,
        nativeThreadId,
        turnId: null,
        interruptRequested: false,
      })
      return {
        id: `codex_${randomUUID()}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: nativeThreadId,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    } catch (error) {
      // 初始化失败时结束子进程，避免泄漏 app-server。
      client.close()
      throw error
    }
  }

  /** 发起一个 turn，消费该 turn 的全部通知直到终态或中断。 */
  async send(
    session: ProviderSessionHandle,
    input: CodexUserInput,
    runtime: ProviderRuntime,
  ): Promise<void> {
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

  /** 中断该 session 当前活跃的 turn；没有活跃 turn 时为空操作。 */
  async interrupt(session: ProviderSessionHandle): Promise<void> {
    const state = this.stateFor(session)
    if (!state) return
    await interruptTurn(state)
  }

  /** 关闭 app-server 并释放 session 状态。 */
  async dispose(session: ProviderSessionHandle): Promise<void> {
    const keys = [session.nativeSessionId, session.threadId].filter((value): value is string =>
      Boolean(value),
    )
    for (const key of keys) {
      const state = this.sessions.get(key)
      if (!state) continue
      state.client.close()
      this.sessions.delete(key)
    }
  }

  /** 按原生 thread id 或本地 thread id 查找 session 状态。 */
  private stateFor(session: ProviderSessionHandle): CodexSessionState | undefined {
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
  return {
    cwd: input.cwd,
    approvalPolicy: permissionMode === "danger-full-access" ? "never" : "on-request",
    sandbox,
    ...(input.model ? { model: input.model } : {}),
  }
}

/** 把通知映射后逐条交给 run 的实时事件出口。 */
function emit(runtime: ProviderRuntime, method: string, params: unknown): void {
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
  return new Promise((resolve) => {
    let settled = false
    let dispose: () => void = () => undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      dispose()
      signal.removeEventListener("abort", finish)
      resolve()
    }
    dispose = client.onNotification("turn/completed", (params) => {
      const completed = completedTurnId(params)
      if (turnId && completed && completed !== turnId) return
      finish()
    })
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
