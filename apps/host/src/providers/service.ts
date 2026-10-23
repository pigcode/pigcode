/** providers 服务对外的契约；实现见 registry.ts。 */
import type {
  PendingRequest,
  ProviderCapabilities,
  ProviderEvent,
  ProviderModel,
  ProviderSession,
  ProviderSettingsValues,
  ProviderStatus,
  ReasoningEffort,
  RunStatus,
} from "@pigcode/contracts"
import type { DetectOptions } from "./agent-catalog"
import type { ApprovalDecision, ApprovalRequest, ProviderDriver } from "./driver"
import type { RestartRecovery } from "./restart"
import type { RunSummary } from "./run-queue"
import type { Switch } from "./switching"

/** 一次 run 的句柄；done 在 run 进入终态后 resolve。 */
export interface StartRunResult {
  runId: string
  done: Promise<void>
}

/** run 的可选参数；effort 只作用于本次 run。 */
export interface StartRunOptions {
  effort?: ReasoningEffort
}

/** 一次审批请求的句柄；decision 在 UI 决议后 resolve。 */
export interface ApprovalHandle {
  requestId: string
  decision: Promise<ApprovalDecision>
}

/** provider 注册表与运行生命周期入口。 */
export interface ProvidersService {
  register(driver: ProviderDriver): void
  /** 移除插件注册的 driver；插件卸载时由其 effect 清理调用。 */
  unregister(driverId: string): void
  list(): Array<{ id: string; displayName: string; capabilities: ProviderCapabilities }>
  /** 只读检测已注册 agent：是否安装、版本与登录状态；结果短时缓存，refresh 时重新检测。 */
  detect(options?: DetectOptions): Promise<Record<string, ProviderStatus>>
  /** 读取 provider 的模型目录（含用户添加的自定义模型）；agent 自己的目录按 provider 缓存。 */
  models(providerId: string): Promise<ProviderModel[]>
  /** 新会话的默认 agent：强制指定 > 用户选择 > 第一个可用的；没有任何 agent 时为 null。 */
  defaultProvider(): Promise<string | null>
  /** 用户在设置页选择的默认 agent；没选时为 null。 */
  configuredDefaultProvider(): string | null
  setDefaultProvider(providerId: string | null): void
  /** agent 当前的设置值。 */
  getSettings(providerId: string): ProviderSettingsValues
  /** 整体替换 agent 的设置值，返回规范化后保存的值；对之后的检测、模型目录与新会话生效。 */
  updateSettings(providerId: string, values: Record<string, unknown>): ProviderSettingsValues
  /** 切换线程 provider/model；同 provider 写 fork 源，跨 provider 写 handoff。 */
  switchProvider(threadId: string, providerId: string, modelId?: string | null): Promise<Switch>
  startRun(
    threadId: string,
    text: string,
    emitLive?: (event: ProviderEvent) => void,
    options?: StartRunOptions,
  ): Promise<StartRunResult>
  requestApproval(threadId: string, runId: string, request: ApprovalRequest): ApprovalHandle
  respondApproval(
    threadId: string,
    runId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): void
  /** 回答 agent 的提问；answers 与问题顺序一致。 */
  answerQuestion(threadId: string, runId: string, requestId: string, answers: string[]): void
  getRunStatus(runId: string): RunStatus | null
  cancelRun(runId: string): boolean
  /** 列出运行中与排队中的 run，供 run.list 查询。 */
  listRuns(): RunSummary[]
  /** Host 退出时中断所有活跃与排队中的 run。 */
  cancelAll(): void
  /** 读取线程的 provider 会话记录，用于验证 native session 复用。 */
  listSessions(threadId: string): ProviderSession[]
  /** 读取线程仍未处理的审批/提问请求。 */
  listPendingRequests(threadId: string): PendingRequest[]
  /** Host 启动后清理上一个进程遗留的 run、session 与 pending 请求。 */
  recoverAfterRestart(): RestartRecovery
}
