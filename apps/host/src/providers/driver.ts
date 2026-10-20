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

/** 创建 provider 会话所需的输入。 */
export interface CreateSessionInput {
  threadId: string
  cwd: string
  nativeSessionId?: string | null
  permissionMode?: string
  model?: string | null
}

/** 用户发送给 provider 的一条输入。 */
export interface UserInput {
  text: string
}

/** 单次 run 交给 driver 的运行时能力：取消信号、事件出口与审批回调。 */
export interface ProviderRuntime {
  signal: AbortSignal
  emit(event: ProviderEvent): void
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
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
}
