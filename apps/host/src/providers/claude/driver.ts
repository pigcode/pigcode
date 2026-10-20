/** Claude Code adapter；SDK 负责进程、流式与权限回调。 */
import {
  query,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk"
import type { ProviderCapabilities } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionInput,
  ProviderDriver,
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "../driver"
import { createNormalizeState, normalizeSdkMessage } from "./normalize"

/** 可注入的 query 实现，便于测试替换真实 CLI 进程。 */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => Query

/** driver 的可选依赖；测试可替换 query 与 CLI 可执行文件路径。 */
export interface ClaudeDriverOptions {
  queryFn?: ClaudeQueryFn
  executable?: string
}

/** 单个 provider 会话的运行时状态；承载取消信号与当前 SDK Query。 */
interface DriverSessionState {
  controller: AbortController
  query: Query | null
  interruptRequested: boolean
}

/** 基于 @anthropic-ai/claude-agent-sdk 的 Claude Code provider。 */
export class ClaudeDriver implements ProviderDriver {
  readonly id = "claude"
  readonly displayName = "Claude Code"
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    questions: false,
    plan: true,
    resume: true,
    fork: false,
    rollback: false,
    checkpoint: false,
    subagents: true,
    mcp: true,
    images: true,
    usage: true,
    modelCatalog: true,
    nativeSessionId: true,
  }

  private readonly queryFn: ClaudeQueryFn
  private readonly executable: string | undefined
  private readonly sessionStates = new Map<string, DriverSessionState>()

  constructor(options: ClaudeDriverOptions = {}) {
    this.queryFn = options.queryFn ?? query
    this.executable = options.executable
  }

  /** 创建内存句柄；原生会话在首次 send 后由 SDK init 消息补充。 */
  async createSession(input: CreateSessionInput): Promise<ProviderSessionHandle> {
    const id = `claude_${randomUUID()}`
    this.sessionStates.set(id, {
      controller: new AbortController(),
      query: null,
      interruptRequested: false,
    })
    return {
      id,
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId ?? null,
      permissionMode: input.permissionMode ?? "workspace-write",
      model: input.model ?? null,
    }
  }

  /** 发起一次 query，并把 SDK 消息逐个归一化为 provider 事件。 */
  async send(
    session: ProviderSessionHandle,
    input: UserInput,
    runtime: ProviderRuntime,
  ): Promise<void> {
    const state = this.stateFor(session.id)
    // 同一会话只允许一个活跃 Query；旧 Query 先中断再替换。
    if (state.query) this.abortState(state)
    state.controller = new AbortController()
    state.interruptRequested = false

    const normalizeState = createNormalizeState()
    const queryStream = this.queryFn({
      prompt: input.text,
      options: {
        cwd: session.cwd,
        ...(session.nativeSessionId ? { resume: session.nativeSessionId } : {}),
        includePartialMessages: true,
        ...(this.executable ? { pathToClaudeCodeExecutable: this.executable } : {}),
        permissionMode: mapPermissionMode(session.permissionMode),
        ...(session.permissionMode === "danger-full-access"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        canUseTool: async (toolName, toolInput, options) => {
          const request: ApprovalRequest = { toolName, input: toolInput }
          if (options.title !== undefined) request.title = options.title
          if (options.displayName !== undefined) request.displayName = options.displayName
          if (options.description !== undefined) request.description = options.description
          if (options.blockedPath !== undefined) request.blockedPath = options.blockedPath
          if (options.suggestions !== undefined) request.suggestions = options.suggestions
          const decision = await runtime.requestApproval(request)
          return toPermissionResult(decision, toolName, options.suggestions)
        },
      },
    })
    state.query = queryStream

    // run 的取消信号到达时中断 SDK Query；即使 SDK 不结束流也停止消费。
    const onAbort = (): void => this.abortState(state)
    runtime.signal.addEventListener("abort", onAbort, { once: true })
    if (runtime.signal.aborted) onAbort()

    const iterator = queryStream[Symbol.asyncIterator]()
    const aborted = abortedSignal(state.controller.signal)
    try {
      while (!state.controller.signal.aborted) {
        const nextPromise = iterator.next()
        // 中断后放弃的 next 仍可能 reject，挂一个处理器避免未处理拒绝。
        void nextPromise.catch(() => undefined)
        const next = await Promise.race([nextPromise, aborted])
        if (next === "aborted" || next.done) break
        for (const event of normalizeSdkMessage(next.value, normalizeState)) runtime.emit(event)
      }
    } catch (error) {
      if (!state.controller.signal.aborted) {
        runtime.emit({
          type: "run.failed",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      runtime.signal.removeEventListener("abort", onAbort)
      if (state.query === queryStream) state.query = null
      if (state.controller.signal.aborted) {
        const returned = iterator.return?.()
        void returned?.catch(() => undefined)
      }
    }
  }

  /** 中断该会话当前活跃的 Query；没有活跃 Query 时为空操作。 */
  async interrupt(session: ProviderSessionHandle): Promise<void> {
    const state = this.sessionStates.get(session.id)
    if (state) this.abortState(state)
  }

  /** 中断并释放会话状态；SDK 子进程由 interrupt 结束。 */
  async dispose(session: ProviderSessionHandle): Promise<void> {
    const state = this.sessionStates.get(session.id)
    if (!state) return
    this.abortState(state)
    this.sessionStates.delete(session.id)
  }

  /** 读取或创建会话状态。 */
  private stateFor(sessionId: string): DriverSessionState {
    const existing = this.sessionStates.get(sessionId)
    if (existing) return existing
    const state: DriverSessionState = {
      controller: new AbortController(),
      query: null,
      interruptRequested: false,
    }
    this.sessionStates.set(sessionId, state)
    return state
  }

  /** 只中断一次：abort 控制器并调用 SDK Query.interrupt。 */
  private abortState(state: DriverSessionState): void {
    if (state.interruptRequested) return
    state.interruptRequested = true
    state.controller.abort()
    const activeQuery = state.query
    if (activeQuery) void activeQuery.interrupt().catch(() => undefined)
  }
}

/** 把 AbortSignal 转成可参与 Promise.race 的哨兵值。 */
function abortedSignal(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted")
      return
    }
    signal.addEventListener("abort", () => resolve("aborted"), { once: true })
  })
}

/** 把 Pigcode 权限模式映射到 Claude SDK 的 permissionMode。 */
function mapPermissionMode(mode: string): NonNullable<Options["permissionMode"]> {
  switch (mode) {
    case "read-only":
      return "plan"
    case "danger-full-access":
      return "bypassPermissions"
    case "plan":
      return "plan"
    default:
      return "default"
  }
}

/** 把审批决议转换为 canUseTool 需要的 PermissionResult。 */
function toPermissionResult(
  decision: ApprovalDecision,
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  if (decision === "deny") return { behavior: "deny", message: "用户拒绝了这次工具调用" }
  if (decision === "allow-for-session") {
    return {
      behavior: "allow",
      updatedPermissions: suggestions ?? [
        { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
      ],
    }
  }
  return { behavior: "allow" }
}
