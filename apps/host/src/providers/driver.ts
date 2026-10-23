/** Provider adapter 的 Host 侧契约；与插件 SDK 是同一套类型，应用层只依赖规范化事件。 */
export type {
  AgentQuestion,
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionInput,
  ProviderDriver,
  ProviderModelInfo,
  ProviderRuntime,
  ProviderSessionHandle,
  ProviderSettingsValues,
  ProviderStatus,
  QuestionRequest,
  SessionMcp,
  UserInput,
} from "@pigcode/plugin-sdk"

/** provider 服务的运行配置；并发默认 4，排队上限默认 32。 */
export interface ProviderRunConfig {
  maxConcurrentRuns?: number
  maxQueuedRuns?: number
  /**
   * 注册开发与测试用的 fake agent；缺省时注册。随应用发布的 profile 关掉它，
   * 此时只有 `PIGCODE_PROVIDER=fake`（E2E 与手动冒烟）会重新打开。
   */
  fake?: boolean
}
