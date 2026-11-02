/** Agent driver 的 Host 侧契约；与插件 SDK 是同一套类型，应用层只依赖规范化事件。 */
import type { AgentDriver, LegacyAgentDriver } from "@pigcode/plugin-sdk"

export type {
  AgentQuestion,
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionInput,
  AgentDriver,
  AgentModelInfo,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  AgentStatus,
  QuestionRequest,
  SessionMcp,
  UserInput,
} from "@pigcode/plugin-sdk"
export { agentFeaturesOf } from "@pigcode/plugin-sdk"

/**
 * 插件注册给 Host 的 driver。旧写法的 driver 把 Agent 功能写在 `capabilities` 里，
 * 读 Agent 功能一律经过 agentFeaturesOf；#35 删除旧写法后只剩 AgentDriver。
 */
export type RegisteredAgentDriver = AgentDriver | LegacyAgentDriver

/** agents 服务的运行配置；并发默认 4，排队上限默认 32。 */
export interface AgentRunConfig {
  maxConcurrentRuns?: number
  maxQueuedRuns?: number
  /**
   * 注册开发与测试用的 fake agent；缺省时注册。随应用发布的 profile 关掉它，
   * 此时只有 `PIGCODE_AGENT=fake`（或旧名字 `PIGCODE_PROVIDER=fake`，E2E 与手动冒烟）会重新打开。
   */
  fake?: boolean
}
