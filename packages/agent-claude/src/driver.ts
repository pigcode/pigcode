/** Claude Code adapter；SDK 负责进程、流式与权限回调。 */
import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
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
  SessionMcp,
  UserInput,
} from "@pigcode/plugin-sdk"
import { detectClaude, type ClaudeDetection } from "./detect"
import { claudeLaunch, sdkExecutable, type ClaudeLaunch } from "./launch"
import { claudeMcpServer } from "./mcp"
import { claudeModelOption, listClaudeModels, toClaudeEffort } from "./models"
import { createNormalizeState, normalizeSdkMessage } from "./normalize"
import { answerRecord, parseQuestions } from "./questions"

/** 可注入的 query 实现，便于测试替换真实 CLI 进程。 */
export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options: Options
}) => Query

/** driver 的可选依赖；测试可替换 query、CLI 可执行文件路径与安装检测。 */
export interface ClaudeDriverOptions {
  queryFn?: ClaudeQueryFn
  /** 固定的可执行文件；给了就不再读设置页里的路径。 */
  executable?: string
  detect?: (launch: ClaudeLaunch) => Promise<ClaudeDetection>
}

/** 单个 Agent 会话的运行时状态；承载取消信号与当前 SDK Query。 */
interface DriverSessionState {
  controller: AbortController
  query: Query | null
  interruptRequested: boolean
  /** 下一次 send 需要从该原生会话 fork；首次成功启动 Query 后清空。 */
  forkFromNativeSessionId: string | null
  /** 创建会话时传入的插件 MCP 工具；每次 send 据此建一个进程内 server。 */
  mcp?: SessionMcp
  /** 创建会话时的设置；每个 run 开始前 Host 都会重新创建会话，所以总是最新的一份。 */
  settings?: AgentSettingsValues
}

/** 基于 @anthropic-ai/claude-agent-sdk 的 Claude Code driver。 */
export class ClaudeDriver implements AgentDriver {
  readonly id = "claude"
  readonly displayName = "Claude Code"
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: true,
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
  private readonly fixedExecutable: string | undefined
  private readonly probe: (launch: ClaudeLaunch) => Promise<ClaudeDetection>
  private readonly sessionStates = new Map<string, DriverSessionState>()

  constructor(options: ClaudeDriverOptions = {}) {
    this.queryFn = options.queryFn ?? query
    this.fixedExecutable = options.executable
    this.probe =
      options.detect ?? ((launch) => detectClaude({ command: launch.executable, env: launch.env }))
  }

  /** 只读检测：版本与登录状态，用设置页里的可执行文件与环境变量。 */
  async detect(settings: AgentSettingsValues): Promise<AgentStatus> {
    const detection = await this.probe(claudeLaunch(settings, this.fixedExecutable))
    const account = [detection.subscriptionType, detection.authMethod].filter(Boolean).join(" · ")
    return {
      installed: detection.installed,
      version: detection.version,
      authenticated: detection.installed ? detection.loggedIn : null,
      account: account || null,
      command: detection.command,
      error: detection.error,
    }
  }

  /** 模型目录：CLI 已登录时从 SDK 读取，否则返回 CLI 认得的模型别名。 */
  async listModels(settings: AgentSettingsValues = {}): Promise<AgentModelInfo[]> {
    const launch = claudeLaunch(settings, this.fixedExecutable)
    return listClaudeModels({
      queryFn: this.queryFn,
      executable: sdkExecutable(launch.executable),
      env: launch.env,
      detect: () => this.probe(launch),
    })
  }

  /** 创建或复用会话状态；复用时会刷新 MCP 工具表，插件启停对下一次 run 生效。 */
  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const id = input.sessionId ?? `claude_${randomUUID()}`
    const existing = this.sessionStates.get(id)
    if (existing) {
      existing.forkFromNativeSessionId = input.forkFromNativeSessionId ?? null
      if (input.mcp) existing.mcp = input.mcp
      else delete existing.mcp
      if (input.settings) existing.settings = input.settings
      else delete existing.settings
    } else {
      this.sessionStates.set(id, {
        controller: new AbortController(),
        query: null,
        interruptRequested: false,
        forkFromNativeSessionId: input.forkFromNativeSessionId ?? null,
        ...(input.mcp ? { mcp: input.mcp } : {}),
        ...(input.settings ? { settings: input.settings } : {}),
      })
    }
    return {
      id,
      threadId: input.threadId,
      cwd: input.cwd,
      // fork 会产生新的原生会话，创建时还不知道其 id，不能沿用父会话 id。
      nativeSessionId: input.forkFromNativeSessionId ? null : (input.nativeSessionId ?? null),
      permissionMode: input.permissionMode ?? "workspace-write",
      model: input.model ?? null,
    }
  }

  /** 发起一次 query，并把 SDK 消息逐个归一化为 Agent 事件。 */
  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime): Promise<void> {
    const state = this.stateFor(session.id)
    // 同一会话只允许一个活跃 Query；旧 Query 先中断再替换。
    if (state.query) this.abortState(state)
    state.controller = new AbortController()
    state.interruptRequested = false

    const normalizeState = createNormalizeState()
    // 切换 Agent 后，handoff 放在用户文本之前，保持上下文连续。
    const prompt = input.handoff ? `${input.handoff}\n\n${input.text}` : input.text
    // 同一 Agent 切换优先原生 fork：resume 父会话并 forkSession，得到新的会话 id。
    const forkFromNativeSessionId = state.forkFromNativeSessionId
    const resumeId = forkFromNativeSessionId ?? session.nativeSessionId
    const model = claudeModelOption(session.model)
    const launch = claudeLaunch(state.settings, this.fixedExecutable)
    const mcpServer = state.mcp ? claudeMcpServer(state.mcp) : null
    const queryStream = this.queryFn({
      prompt,
      options: {
        cwd: session.cwd,
        ...(model ? { model } : {}),
        // 模型不支持的档位由 CLI 自动降级。
        ...(input.effort ? { effort: toClaudeEffort(input.effort) } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        ...(forkFromNativeSessionId ? { forkSession: true } : {}),
        includePartialMessages: true,
        // 子 agent 的文本/思考块也作为带 parent_tool_use_id 的消息转发，供时间线归组。
        forwardSubagentText: true,
        ...(launch.executable
          ? { pathToClaudeCodeExecutable: sdkExecutable(launch.executable) ?? launch.executable }
          : {}),
        ...(launch.env ? { env: launch.env } : {}),
        ...(Object.keys(launch.extraArgs).length > 0 ? { extraArgs: launch.extraArgs } : {}),
        // 插件工具以进程内 SDK MCP server 暴露，生命周期跟随本次 Query。
        ...(mcpServer ? { mcpServers: { pigcode: mcpServer as McpServerConfig } } : {}),
        permissionMode: mapPermissionMode(session.permissionMode),
        ...(session.permissionMode === "danger-full-access"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        canUseTool: async (toolName, toolInput, options) => {
          // AskUserQuestion 不是要批准的操作，而是要用户作答：答案按问题原文写回工具输入。
          const questions = toolName === "AskUserQuestion" ? parseQuestions(toolInput) : null
          if (questions && runtime.askQuestions) {
            const answers = await runtime.askQuestions({ questions })
            // 这句话写给模型，不显示在界面上，所以固定用英文，不跟随界面语言。
            if (answers.length === 0) {
              return { behavior: "deny", message: "The user did not answer these questions." }
            }
            return {
              behavior: "allow",
              updatedInput: { ...toolInput, answers: answerRecord(questions, answers) },
            }
          }
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
    // fork 只作用于切换后的第一次 send；后续 send 由 init 消息更新出的原生 id 恢复。
    state.forkFromNativeSessionId = null

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
  async interrupt(session: AgentSessionHandle): Promise<void> {
    const state = this.sessionStates.get(session.id)
    if (state) this.abortState(state)
  }

  /** 中断并释放会话状态；SDK 子进程由 interrupt 结束。 */
  async dispose(session: AgentSessionHandle): Promise<void> {
    const state = this.sessionStates.get(session.id)
    if (!state) return
    this.abortState(state)
    this.sessionStates.delete(session.id)
  }

  /** 插件停用时结束所有会话的 Query，不留下 Claude Code 子进程。 */
  close(): void {
    for (const state of this.sessionStates.values()) this.abortState(state)
    this.sessionStates.clear()
  }

  /** 读取或创建会话状态。 */
  private stateFor(sessionId: string): DriverSessionState {
    const existing = this.sessionStates.get(sessionId)
    if (existing) return existing
    const state: DriverSessionState = {
      controller: new AbortController(),
      query: null,
      interruptRequested: false,
      forkFromNativeSessionId: null,
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
    case "dontAsk":
      // 真实冒烟使用 dontAsk：不弹权限提示，未预授权的工具直接拒绝。
      return "dontAsk"
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
  // 拒绝原因写给模型，不显示在界面上，所以固定用英文，不跟随界面语言。
  if (decision === "deny") return { behavior: "deny", message: "The user denied this tool call." }
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
