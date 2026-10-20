/** Provider adapter 的 Host 侧契约；应用层只依赖规范化事件。 */
import type { ProviderCapabilities, ProviderEvent } from "@pigcode/contracts"

/** 单个 provider 会话的句柄，承载线程关联与原生会话标识。 */
export interface ProviderSessionHandle {
  id: string
  threadId: string
  cwd: string
  nativeSessionId: string | null
}

/** 创建 provider 会话所需的输入。 */
export interface CreateSessionInput {
  threadId: string
  cwd: string
}

/** 用户发送给 provider 的一条输入。 */
export interface UserInput {
  text: string
}

/** 把 provider 的规范化事件交给 Host 的回调。 */
export type ProviderEmit = (event: ProviderEvent) => void

/** Provider adapter 需要实现的完整契约。 */
export interface ProviderDriver {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  createSession(input: CreateSessionInput): Promise<ProviderSessionHandle>
  send(session: ProviderSessionHandle, input: UserInput, emit: ProviderEmit): Promise<void>
  interrupt(session: ProviderSessionHandle): Promise<void>
  dispose(session: ProviderSessionHandle): Promise<void>
}
