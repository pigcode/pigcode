/** Host 侧插件的稳定入口类型；插件不直接依赖 Cordis 内部实现。 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { McpToolDefinition } from "./mcp"
import type { AgentDriver } from "./agent"

/** Capability 插件可用的只读会话视图；Host 的 sessions 服务结构上满足该契约。 */
export interface PluginSessions {
  /** 读取指定线程从 cursor 开始的事件；只读，不允许插件改写事件日志。 */
  read(threadId: string, cursor: number): readonly ThreadEvent[]
}

/** 工具调用发生时的线程上下文；插件据此区分并行会话。 */
export interface McpToolCallContext {
  threadId: string
}

/** 工具处理函数；返回值会被序列化后交给模型。 */
export type McpToolHandler = (input: unknown, context: McpToolCallContext) => Promise<unknown>

/** 插件可用的 MCP 工具注册接口；由 Host 的 mcpBridge 服务提供。 */
export interface McpBridgeApi {
  /** 注册工具并返回注销函数；插件卸载时 Host 也会统一清理。 */
  registerTool(pluginId: string, tool: McpToolDefinition, handler: McpToolHandler): () => void
  /** 列出当前所有已注册工具。 */
  listTools(): McpToolDefinition[]
}

/** Agent 插件注册 driver 的入口；Host 以 Cordis 服务 `agents` 提供。 */
export interface AgentRegistry {
  register(driver: AgentDriver): void
  unregister(id: string): void
}

/** Host 插件可用的最小上下文；只暴露稳定契约，不暴露 Host 内部服务。 */
export interface PluginHostContext {
  /** 只读会话访问；未在 manifest.inject 声明 sessions 时不可用。 */
  readonly sessions: PluginSessions
  /** 注册一个供其他插件或 Host 使用的能力。 */
  provide(name: string, value: unknown): void
  /** 注册随插件卸载执行的清理逻辑。 */
  effect(setup: () => (() => void | Promise<void>) | void): void
  /** 注册 Agent driver；manifest.inject 或插件导出的 inject 里写 `agents`。 */
  agents: AgentRegistry
  /** MCP 工具注册；Host 以 Cordis 服务 `mcp` 提供。 */
  readonly mcp: McpBridgeApi
}

export type HostPlugin = (ctx: PluginHostContext, config: unknown) => void | Promise<void>

/** 保留一层薄封装，未来可以在不破坏插件的情况下替换容器。 */
export function defineHostPlugin(plugin: HostPlugin): HostPlugin {
  return plugin
}
