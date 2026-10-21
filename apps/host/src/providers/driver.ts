/** Provider adapter 的 Host 侧契约；应用层只依赖规范化事件。 */
import type { ProviderCapabilities, ProviderEvent } from "@pigcode/contracts"

/** 审批决议；UI 只提交这三种。 */
export type ApprovalDecision = "allow-once" | "allow-for-session" | "deny"

/** provider 发起的一次审批请求；字段用于持久化与 UI 展示。 */
export interface ApprovalRequest {
  toolName: string
  input: unknown
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  suggestions?: unknown
}

/** 单个 provider 会话的句柄，承载线程关联与原生会话标识。 */
export interface ProviderSessionHandle {
  id: string
  threadId: string
  cwd: string
  nativeSessionId: string | null
  permissionMode: string
  model: string | null
}

/** 本次会话可用的插件 MCP 能力；由 registry 按线程从 mcpBridge 生成。 */
export interface SessionMcp {
  /** Claude Agent SDK 的进程内 MCP server；没有插件工具时为 null。 */
  claudeServer?: unknown
  /** Codex `config` 片段（含 mcp_servers）；没有插件工具时为 null。 */
  codexConfig?: Record<string, unknown> | null
}

/** 创建 provider 会话所需的输入。 */
export interface CreateSessionInput {
  threadId: string
  cwd: string
  nativeSessionId?: string | null
  /** 原生 fork 的源会话；与 nativeSessionId 互斥，支持 fork 的 driver 会创建新会话。 */
  forkFromNativeSessionId?: string
  permissionMode?: string
  model?: string | null
  /** 线程作用域的插件工具；不支持 MCP 的 driver 可以忽略。 */
  mcp?: SessionMcp | undefined
}

/** 用户发送给 provider 的一条输入；handoff 在切换 provider 后注入一次。 */
export interface UserInput {
  text: string
  handoff?: string
}

/** 单次 run 交给 driver 的运行时能力：取消信号、事件出口与审批回调。 */
export interface ProviderRuntime {
  signal: AbortSignal
  emit(event: ProviderEvent): void
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
}

/** provider 暴露的模型条目；不同 CLI 的目录统一成这个形状。 */
export interface ProviderModelInfo {
  id: string
  displayName: string
  isDefault: boolean
}

/** provider 插件运行配置；并发默认 4，排队上限默认 32。 */
export interface ProviderRunConfig {
  maxConcurrentRuns?: number
  maxQueuedRuns?: number
}

/** Provider adapter 需要实现的完整契约。 */
export interface ProviderDriver {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  createSession(input: CreateSessionInput): Promise<ProviderSessionHandle>
  send(session: ProviderSessionHandle, input: UserInput, runtime: ProviderRuntime): Promise<void>
  interrupt(session: ProviderSessionHandle): Promise<void>
  dispose(session: ProviderSessionHandle): Promise<void>
  /** 可选：支持动态模型目录的 provider 实现。 */
  listModels?(): Promise<ProviderModelInfo[]>
}
