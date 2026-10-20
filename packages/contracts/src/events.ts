/** 定义持久线程事件、规范化 provider 事件和订阅快照。 */
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
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
  "plan.updated",
  "file.changed",
  "usage.updated",
  "subagent.started",
  "subagent.completed",
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

/** provider 适配器输出的规范化事件。 */
export const providerEventSchema = z.discriminatedUnion("type", [
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
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("subagent.started"),
    toolCallId: z.string(),
    name: z.string(),
    description: z.string().optional(),
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
  z.object({ type: z.literal("usage.updated"), usage: z.unknown() }),
  z.object({
    type: z.literal("plan.updated"),
    plan: z.unknown(),
    explanation: z.string().nullable(),
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
/** 规范化 provider 事件的类型。 */
export type ProviderEvent = z.infer<typeof providerEventSchema>
/** 线程订阅快照的类型。 */
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>
/** 终端输出通知的类型。 */
export type TerminalOutput = z.infer<typeof terminalOutputSchema>
