/** 定义持久线程事件、规范化 Agent 事件和订阅快照。 */
import { z } from "zod"

/** 持久线程事件的类型枚举。 */
export const threadEventTypeSchema = z.enum([
  "thread.created",
  "thread.updated",
  "session.started",
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "message.completed",
  "reasoning.completed",
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
  "plan.updated",
  "notice",
  "file.changed",
  "usage.updated",
  "subagent.started",
  "subagent.completed",
  "workflow.updated",
  "checkpoint.created",
  "plugin.changed",
])

/** 持久化到事件日志的线程事件，seq 在单个线程内单调递增。 */
export const threadEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  threadId: z.string().min(1),
  runId: z.string().nullable(),
  type: threadEventTypeSchema,
  payload: z.unknown(),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
})

/** 工作流里一个 agent 的状态：排队、运行中、完成、失败。 */
export const workflowAgentStateSchema = z.enum(["queued", "running", "done", "failed"])

/** 工作流里的一个 agent。 */
export const workflowAgentSchema = z.object({
  /** 在工作流里的序号，从 1 开始。 */
  index: z.number().int(),
  /** 脚本给它起的标签，例如 review:math.js。 */
  label: z.string(),
  /** 所属阶段的标题。 */
  phase: z.string().optional(),
  state: workflowAgentStateSchema,
  model: z.string().optional(),
  /** 交给它的任务开头一段。 */
  prompt: z.string().optional(),
  /** 运行中最近一次在做的事：工具名与对象。 */
  activity: z.string().optional(),
  tokens: z.number().optional(),
  toolCalls: z.number().optional(),
  durationMs: z.number().optional(),
  /** 完成后交回的结果开头一段。 */
  result: z.string().optional(),
})

/** 工作流的整体状态。 */
export const workflowStatusSchema = z.enum(["running", "completed", "failed", "stopped"])

/**
 * 一个工作流（Claude Code 的 Workflow 工具，Ultracode 打开时会用）的快照：每次有变化时发一份完整的，
 * 界面按 toolCallId 合并，后到的字段覆盖先到的。script 只在第一份里带。
 */
export const workflowSnapshotSchema = z.object({
  /** 发起它的 Workflow 工具调用。 */
  toolCallId: z.string(),
  taskId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  /** 工作流脚本。 */
  script: z.string().optional(),
  status: workflowStatusSchema,
  phases: z.array(z.object({ index: z.number().int(), title: z.string() })),
  agents: z.array(workflowAgentSchema),
  usage: z
    .object({
      tokens: z.number().optional(),
      toolCalls: z.number().optional(),
      durationMs: z.number().optional(),
    })
    .optional(),
  /** 结束时的说明，失败时是原因。 */
  summary: z.string().optional(),
  parentToolUseId: z.string().optional(),
})

/** Agent driver 输出的规范化事件。 */
export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started") }),
  z.object({ type: z.literal("session.started"), nativeSessionId: z.string() }),
  z.object({
    type: z.literal("message.delta"),
    text: z.string(),
    /** 子 agent 产生的文本携带父 tool_use id，主时间线据此跳过。 */
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("message.completed"),
    text: z.string(),
    parentToolUseId: z.string().optional(),
  }),
  /** 模型的思考过程（Claude 的 thinking、Codex 的 reasoning 摘要）；增量只走实时通道。 */
  z.object({
    type: z.literal("reasoning.delta"),
    text: z.string(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("reasoning.completed"),
    text: z.string(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.started"),
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    toolCallId: z.string(),
    name: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
    /** 命令类工具的退出码；Agent 不报告时缺省。 */
    exitCode: z.number().int().nullable().optional(),
    parentToolUseId: z.string().optional(),
  }),
  /** 运行中命令的输出片段；只走实时通道，完整输出在 tool.completed 里落库。 */
  z.object({
    type: z.literal("tool.outputDelta"),
    toolCallId: z.string(),
    delta: z.string(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("subagent.started"),
    toolCallId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    /** 主 agent 交给子 agent 的完整任务。 */
    prompt: z.string().optional(),
    model: z.string().optional(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("subagent.completed"),
    toolCallId: z.string(),
    output: z.unknown().optional(),
    isError: z.boolean(),
    status: z.enum(["completed", "failed", "interrupted"]),
  }),
  z.object({ type: z.literal("workflow.updated"), workflow: workflowSnapshotSchema }),
  z.object({ type: z.literal("usage.updated"), usage: z.unknown() }),
  z.object({
    type: z.literal("plan.updated"),
    plan: z.unknown(),
    explanation: z.string().nullable(),
  }),
  /**
   * 会话里需要用户知道的一件事：还能继续，但有东西没接上（例如插件工具的 MCP 桥起不来）。
   * 文案由界面按 key 选择，driver 只给稳定的键和参数，避免中文界面里出现英文句子。
   */
  z.object({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    key: z.string().min(1),
    params: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal("run.completed") }),
  z.object({ type: z.literal("run.failed"), message: z.string() }),
  z.object({ type: z.literal("run.interrupted") }),
])

/** 终端输出通知；只走实时通道，不写入事件日志。 */
export const terminalOutputSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
})

/** 线程订阅快照，包含线程、运行、条目与待处理请求。 */
export const threadSnapshotSchema = z.object({
  thread: z.object({}).passthrough(),
  runs: z.array(z.object({}).passthrough()),
  items: z.array(z.object({}).passthrough()),
  pendingRequests: z.array(z.object({}).passthrough()),
})

/** 持久线程事件的类型。 */
export type ThreadEvent = z.infer<typeof threadEventSchema>
/** 规范化 Agent 事件的类型。 */
export type AgentEvent = z.infer<typeof agentEventSchema>
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>
export type WorkflowAgent = z.infer<typeof workflowAgentSchema>
export type WorkflowAgentState = z.infer<typeof workflowAgentStateSchema>
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>
/** 线程订阅快照的类型。 */
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>
/** 终端输出通知的类型。 */
export type TerminalOutput = z.infer<typeof terminalOutputSchema>
