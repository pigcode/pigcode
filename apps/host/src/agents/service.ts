/** agents 服务对外的契约；实现见 registry.ts。 */
import type {
  PendingRequest,
  AgentFeatures,
  AgentEvent,
  AgentInstance,
  AgentModel,
  AgentSession,
  AgentSettingsValues,
  AgentStatus,
  ReasoningEffort,
  RunStatus,
} from "@pigcode/contracts"
import type { DefaultAgentChoice, DetectOptions } from "./agent-catalog"
import type { ApprovalDecision, ApprovalRequest, AgentDriver, UserInput } from "./driver"
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
  /** 本次 run 用快速模式。 */
  fast?: boolean
  /** 本次 run 打开 Ultracode。 */
  ultracode?: boolean
  /** 本次 run 用的实例；缺省时沿用线程最近的实例。 */
  instanceId?: string
}

/** 交给 driver 的输入：文本加上这次 run 选的思考深度、快速模式与 Ultracode。 */
export function runInput(text: string, options: StartRunOptions): UserInput {
  return {
    text,
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.fast ? { fast: true } : {}),
    ...(options.ultracode ? { ultracode: true } : {}),
  }
}

/** 一次审批请求的句柄；decision 在 UI 决议后 resolve。 */
export interface ApprovalHandle {
  requestId: string
  decision: Promise<ApprovalDecision>
}

/** Agent 注册表与运行生命周期入口。 */
export interface AgentsService {
  register(driver: AgentDriver): void
  /** 移除插件注册的 driver；插件卸载时由其 effect 清理调用。 */
  unregister(driverId: string): void
  /** 已注册的 Agent 与它们的 Agent 功能。 */
  list(): Array<{ id: string; displayName: string; features: AgentFeatures }>
  /** 只读检测：是否安装、版本与登录状态；结果短时缓存，refresh 时重新检测。 */
  detect(options?: DetectOptions): Promise<Record<string, AgentStatus>>
  /** 读取实例的模型目录（含用户添加的自定义模型）；Agent 自己的目录按实例缓存。 */
  models(agentId: string, instanceId?: string | null): Promise<AgentModel[]>
  /** 新会话的默认 agent 与实例：强制指定 > 用户选择 > 第一个可用的。 */
  defaultAgent(): Promise<DefaultAgentChoice>
  /** 用户在设置页选择的默认 agent；没选时为 null。 */
  configuredDefaultAgent(): string | null
  /** 用户在设置页选择的默认实例；没选时为 null。 */
  configuredDefaultInstance(): string | null
  setDefaultAgent(agentId: string | null, instanceId?: string | null): void
  /** 实例当前的设置值。 */
  getSettings(agentId: string, instanceId?: string | null): AgentSettingsValues
  /** 整体替换实例的设置值，返回规范化后保存的值；对之后的检测、模型目录与新会话生效。 */
  updateSettings(
    agentId: string,
    values: Record<string, unknown>,
    instanceId?: string | null,
  ): AgentSettingsValues
  /** 一个 Agent 的全部实例，默认实例在前。 */
  listInstances(agentId: string): AgentInstance[]
  /** 按 instanceId 找实例；找不到时为 null。 */
  findInstance(instanceId: string): AgentInstance | null
  createInstance(agentId: string, label: string, copyFrom?: string | null): AgentInstance
  updateInstance(
    instanceId: string,
    patch: {
      label?: string | undefined
      enabled?: boolean | undefined
      values?: Record<string, unknown> | undefined
    },
  ): AgentInstance
  /** 删除实例；默认实例与正被线程使用的实例不能删。 */
  removeInstance(instanceId: string): void
  /** 切换线程的 Agent/实例/model；同一个 Agent 写 fork 源，换 Agent 时写 handoff。 */
  switchAgent(
    threadId: string,
    agentId: string,
    modelId?: string | null,
    instanceId?: string | null,
  ): Promise<Switch>
  startRun(
    threadId: string,
    text: string,
    emitLive?: (event: AgentEvent) => void,
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
  /** 读取线程的 Agent 会话记录，用于验证 native session 复用。 */
  listSessions(threadId: string): AgentSession[]
  /** 读取线程仍未处理的审批/提问请求。 */
  listPendingRequests(threadId: string): PendingRequest[]
  /** Host 启动后清理上一个进程遗留的 run、session 与 pending 请求。 */
  recoverAfterRestart(): RestartRecovery
}
