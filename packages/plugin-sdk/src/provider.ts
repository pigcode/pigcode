/** 第三方 provider 插件使用的稳定契约；不依赖 Host 内部路径。 */
import type { ProviderCapabilities, ProviderEvent } from "@pigcode/contracts"

/** 插件持有的 provider 会话句柄；由 Host 持久化并跨 run 复用。 */
export interface PluginProviderSession {
  id: string
  threadId: string
  cwd: string
  nativeSessionId: string | null
  permissionMode: string
  model: string | null
}

/** 单次 run 交给插件的运行时能力：取消信号、事件出口与审批回调。 */
export interface PluginProviderRuntime {
  signal: AbortSignal
  emit(event: ProviderEvent): void
  requestApproval(request: {
    toolName: string
    input: unknown
  }): Promise<"allow-once" | "allow-for-session" | "deny">
}

/** provider 插件需要实现的完整契约；方法均允许异步返回。 */
export interface ProviderPluginDriver {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
  createSession(input: {
    threadId: string
    cwd: string
    nativeSessionId?: string | null
  }): Promise<PluginProviderSession>
  /** 发送一条用户输入；事件通过 runtime.emit 推送。 */
  send(
    session: PluginProviderSession,
    input: { text: string; handoff?: string },
    runtime: PluginProviderRuntime,
  ): Promise<void>
  /** 中断当前 run；Host 也会通过 runtime.signal 通知插件。 */
  interrupt(session: PluginProviderSession): Promise<void>
  /** 释放会话资源；插件卸载或切换 provider 时调用。 */
  dispose(session: PluginProviderSession): Promise<void>
}
