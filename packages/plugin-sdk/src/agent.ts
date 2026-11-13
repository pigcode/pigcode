/**
 * Agent driver 的稳定契约。Host 内置的 Claude Code、Codex 与第三方 Agent 插件
 * 实现同一个接口，Host 只依赖这里的类型与规范化事件。
 */
import type {
  AgentEvent,
  AgentFeatures,
  AgentExecutionModes,
  AgentSettingsValues,
  AgentStatus,
  ReasoningEffort,
} from "@pigcode/contracts"
import type { SessionMcp } from "./mcp"

export type {
  AgentExecutionModes,
  AgentPermissionMode,
  AgentModeSelection,
  RuntimeMode,
  AgentSettingsValues,
  AgentStatus,
} from "@pigcode/contracts"

/** 审批决议；界面只提交这三种。 */
export type ApprovalDecision = "allow-once" | "allow-for-session" | "deny"

/** Agent 发起的一次审批请求；字段用于持久化与界面展示。 */
export interface ApprovalRequest {
  toolName: string
  input: unknown
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  suggestions?: unknown
}

/** agent 向用户提的一个问题：标题、可选项，是否多选。 */
export interface AgentQuestion {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/** 一次提问可以包含多个问题。 */
export interface QuestionRequest {
  questions: AgentQuestion[]
}

/** 单个 Agent 会话的句柄，承载线程关联与原生会话标识；由 Host 持久化并跨 run 复用。 */
export interface AgentSessionHandle {
  id: string
  threadId: string
  cwd: string
  nativeSessionId: string | null
  permissionMode: string
  planMode?: boolean
  model: string | null
}

/** 创建 Agent 会话所需的输入。 */
export interface CreateSessionInput {
  threadId: string
  cwd: string
  /** 复用已有会话记录时传入，driver 用它作为内部状态的 key。 */
  sessionId?: string
  nativeSessionId?: string | null
  /** 原生 fork 的源会话；与 nativeSessionId 互斥，支持 fork 的 driver 会创建新会话。 */
  forkFromNativeSessionId?: string
  permissionMode?: string
  planMode?: boolean
  model?: string | null
  /** 插件注册给模型的 MCP 工具；不支持 MCP 的 driver 可以忽略。 */
  mcp?: SessionMcp | undefined
  /** 用户在设置页给这个 agent 填的值；字段由 manifest 的 `contributes.agent.settings` 声明。 */
  settings?: AgentSettingsValues
}

/** 用户发送给 Agent 的一条输入；handoff 在切换 Agent 后注入一次。 */
export interface UserInput {
  text: string
  handoff?: string
  /** 本次 run 的思考深度；不支持的 driver 忽略。 */
  effort?: ReasoningEffort
  /** 本次 run 用快速模式；不支持的 driver 忽略。 */
  fast?: boolean
  /** 本次 run 打开 Ultracode；不支持的 driver 忽略。 */
  ultracode?: boolean
}

/** 单次 run 交给 driver 的运行时能力：取消信号、事件出口、审批与提问。 */
export interface AgentRuntime {
  signal: AbortSignal
  emit(event: AgentEvent): void
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
  /** 向用户提问并等待回答；返回每个问题的答案，用户没答（run 结束）时为空数组。 */
  askQuestions?(request: QuestionRequest): Promise<string[]>
  /** Agent 原生进入或退出计划流程后，同步会话里的独立计划开关。 */
  setPlanMode?(enabled: boolean): void
}

/** Agent 暴露的模型条目；不同 CLI 的目录统一成这个形状。 */
export interface AgentModelInfo {
  id: string
  displayName: string
  isDefault: boolean
  description?: string | undefined
  /** 该模型可选的思考深度；缺省或为空表示不可调。 */
  efforts?: ReasoningEffort[]
  defaultEffort?: ReasoningEffort | null
  /** 该模型支持快速模式。 */
  fast?: boolean | undefined
  /** 该模型支持 Ultracode。 */
  ultracode?: boolean | undefined
}

/** Agent 在输入框 `/` 菜单里提供的命令；形状见 contracts 的 agentCommandSchema。 */
export interface AgentCommandInfo {
  name: string
  /** 插进输入框的文字，例如 `/compact`、`$documents`。 */
  text: string
  description?: string | undefined
  argumentHint?: string | undefined
  kind: "builtin" | "skill"
}

/**
 * Agent driver 需要实现的完整契约；方法均可异步。
 * settings 是用户在设置页填的值，每次调用都传最新的一份：改了设置不需要重新注册 driver，
 * 对之后的检测、模型目录和新会话生效。
 */
export interface AgentDriver {
  readonly id: string
  readonly displayName: string
  /** Agent 功能：这个 Agent 支持哪些功能，界面据此隐藏不支持的控件。 */
  readonly features: AgentFeatures
  /** 接入统一四档权限协议，并声明计划能力；旧插件由 Host 兼容原有权限参数。 */
  readonly executionModes?: AgentExecutionModes
  /** 只读检测：是否安装、版本与登录状态；不能触发登录或创建会话。没实现时视为可用。 */
  detect?(settings: AgentSettingsValues): Promise<AgentStatus>
  /** 插件负责识别安装来源并准备自己的 CLI 更新，Host 负责展示、去重和排队。 */
  prepareCliUpdate?(settings: AgentSettingsValues): Promise<AgentCliUpdatePlan>
  /** 动态模型目录；没实现时目录为空，只列出用户添加的自定义模型。 */
  listModels?(settings: AgentSettingsValues): Promise<AgentModelInfo[]>
  /**
   * 输入框 `/` 菜单里的命令：CLI 自带的命令、skill 与自定义命令。cwd 决定项目级的 skill；
   * 为 null 时只列用户级的。没实现时菜单里只有 Pigcode 自己的命令。
   */
  listCommands?(settings: AgentSettingsValues, cwd: string | null): Promise<AgentCommandInfo[]>
  createSession(input: CreateSessionInput): Promise<AgentSessionHandle>
  /** 发送一条用户输入；事件通过 runtime.emit 推送。 */
  send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime): Promise<void>
  /** 中断当前 run；Host 也会通过 runtime.signal 通知 driver。 */
  interrupt(session: AgentSessionHandle): Promise<void>
  /** 释放会话资源；插件卸载或切换 Agent 时调用。 */
  dispose(session: AgentSessionHandle): Promise<void>
  /**
   * 这条错误是不是「要接续的原生会话已经不存在」（会话文件被删、换了配置目录）。Host 据此改开新会话
   * 并带上交接，而不是让这个会话每次发送都失败。没实现时一律视为否。
   */
  isSessionNotFound?(message: string): boolean
  /**
   * 原生会话存在哪里：两个实例算出来的值相同，就能接着用对方的原生会话（例如配置目录相同的两个 Claude 实例）。
   * 返回 null 或没实现时，只有同一个实例的原生会话能接（#82）。
   */
  continuationKey?(settings: AgentSettingsValues): string | null
}

export interface AgentCliUpdateRuntime {
  signal: AbortSignal
  onOutput: (text: string) => void
}

export interface AgentCliUpdatePlan {
  /** 同一安装的所有实例共用同一个目标标识。 */
  target: string
  currentVersion: string | null
  latestVersion: string | null
  available: boolean
  command: string | null
  reason: import("@pigcode/contracts").AgentCliUpdateState["reason"]
  run?: ((runtime: AgentCliUpdateRuntime) => Promise<void>) | undefined
  /** 按原来的可执行文件复检，确保更新的是当前使用的 CLI。 */
  verify: () => Promise<string | null>
}
