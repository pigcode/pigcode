/**
 * 后台任务与工作流：Claude Code 的 Workflow 工具（Ultracode 打开时会用）在后台跑一组 agent，
 * 工具调用立刻返回，主回合随即结束；工作流跑完后 CLI 在同一个会话里自动续一个回合，把结果交给用户。
 *
 * 这里做两件事：
 * 1. 记下还没结束的后台任务。主回合的 result 到来时如果还有任务在跑，run 不算结束，等续上的回合结束。
 * 2. 把 task_started / task_progress / task_notification 映射成 workflow.updated 快照：阶段、各 agent 的
 *    状态、最近在做的事、耗时与 token、结果开头。只在看得见的内容变化时才发一份，token 计数的跳动不算。
 *
 * 消息形状来自 Claude Code 2.1.304 的真实录制（fixtures/workflow.jsonl）；workflow_progress 不在 SDK
 * 的类型里，所以逐项校验着读，认不得的字段跳过。
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentEvent,
  WorkflowAgent,
  WorkflowAgentState,
  WorkflowSnapshot,
  WorkflowStatus,
} from "@pigcode/contracts"

/** 发起工作流的工具名。 */
export const WORKFLOW_TOOL = "Workflow"

/** 一次 run 里的后台任务状态。 */
export interface TaskState {
  /** 已开始、还没收到 task_notification 的任务。 */
  pending: Set<string>
  /** Workflow 工具调用 id 到它最近一份快照。 */
  workflows: Map<string, WorkflowSnapshot>
  /** 后台任务 id 到发起它的 Workflow 工具调用 id。 */
  taskToTool: Map<string, string>
  /** 每个工作流上一次发出去的可见内容，用来判断要不要再发。 */
  shown: Map<string, string>
}

/** 创建一次 run 的后台任务状态。 */
export function createTaskState(): TaskState {
  return { pending: new Set(), workflows: new Map(), taskToTool: new Map(), shown: new Map() }
}

type WorkflowEvent = Extract<AgentEvent, { type: "workflow.updated" }>

/** 把 unknown 收窄为普通对象。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 非空字符串。 */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/** 有限数字。 */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 去掉 undefined 字段，事件里只留有值的键。 */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

/**
 * 从工作流脚本的 `export const meta = { name: '…', description: '…' }` 里取名字和说明。
 * 脚本是模型写的 JS，这里只认最常见的字面量写法，取不到就等 task_started 带来。
 */
export function scriptMeta(script: string | undefined): {
  name?: string | undefined
  description?: string | undefined
} {
  if (!script) return {}
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? ""
  const field = (key: string) =>
    new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(meta)?.[2]
  return compact({ name: field("name"), description: field("description") })
}

/** SDK 的 agent 状态：start（排队或刚开始）、progress、done，失败时是 error 一类。 */
function agentState(raw: Record<string, unknown>): WorkflowAgentState {
  const state = text(raw.state)
  if (state === "done") return "done"
  if (state === "error" || state === "failed" || state === "cancelled" || state === "killed") {
    return "failed"
  }
  if (state === "start" && raw.startedAt === undefined) return "queued"
  return "running"
}

/** 运行中的 agent 最近在做的事：工具名加对象，例如「Read …/math.js」。 */
function agentActivity(raw: Record<string, unknown>): string | undefined {
  const tool = text(raw.lastToolName)
  if (!tool) return undefined
  const subject = text(raw.lastToolSummary)
  return subject ? `${tool} ${subject}` : tool
}

/** workflow_progress 是一份完整清单：阶段和 agent 按 index 排好。 */
function readProgress(value: unknown): Pick<WorkflowSnapshot, "phases" | "agents"> | undefined {
  if (!Array.isArray(value)) return undefined
  const phases: WorkflowSnapshot["phases"] = []
  const agents: WorkflowAgent[] = []
  for (const item of value) {
    const raw = record(item)
    const index = count(raw?.index)
    if (!raw || index === undefined) continue
    if (raw.type === "workflow_phase") {
      const title = text(raw.title)
      if (title) phases.push({ index, title })
      continue
    }
    if (raw.type !== "workflow_agent") continue
    agents.push(
      compact({
        index,
        label: text(raw.label) ?? `#${index}`,
        phase: text(raw.phaseTitle),
        state: agentState(raw),
        model: text(raw.model),
        prompt: text(raw.promptPreview),
        activity: agentActivity(raw),
        tokens: count(raw.tokens),
        toolCalls: count(raw.toolCalls),
        durationMs: count(raw.durationMs),
        result: text(raw.resultPreview),
      }),
    )
  }
  phases.sort((left, right) => left.index - right.index)
  agents.sort((left, right) => left.index - right.index)
  return { phases, agents }
}

/** 任务用量：总 token、工具调用次数、耗时。 */
function readUsage(value: unknown): WorkflowSnapshot["usage"] {
  const usage = record(value)
  if (!usage) return undefined
  return compact({
    tokens: count(usage.total_tokens),
    toolCalls: count(usage.tool_uses),
    durationMs: count(usage.duration_ms),
  })
}

/** 看得见的内容：状态、阶段、各 agent 的状态、在做的事与结果。token 与耗时的跳动不算。 */
function visible(snapshot: WorkflowSnapshot): string {
  return JSON.stringify([
    snapshot.status,
    snapshot.name,
    snapshot.description,
    snapshot.summary,
    snapshot.phases,
    snapshot.agents.map((agent) => [agent.state, agent.phase, agent.activity, agent.result]),
  ])
}

/** 记下新快照；可见内容有变化（或 force）时返回要发的事件。 */
function update(state: TaskState, next: WorkflowSnapshot, force = false): WorkflowEvent | null {
  state.workflows.set(next.toolCallId, next)
  const shown = visible(next)
  if (!force && state.shown.get(next.toolCallId) === shown) return null
  state.shown.set(next.toolCallId, shown)
  // 脚本只在 workflowStarted 发的第一份里带，后面的快照不重复传几 KB 的源码。
  const rest: WorkflowSnapshot = { ...next }
  delete rest.script
  return { type: "workflow.updated", workflow: rest }
}

/** 主 agent 调用了 Workflow 工具：先画出一张运行中的卡片，名字从脚本里取。 */
export function workflowStarted(
  state: TaskState,
  toolCallId: string,
  input: unknown,
  parentToolUseId: string | null,
): WorkflowEvent {
  const script = text(record(input)?.script)
  const snapshot: WorkflowSnapshot = compact({
    toolCallId,
    ...scriptMeta(script),
    script,
    status: "running" as const,
    phases: [],
    agents: [],
    parentToolUseId: parentToolUseId ?? undefined,
  })
  state.workflows.set(toolCallId, snapshot)
  state.shown.set(toolCallId, visible(snapshot))
  return { type: "workflow.updated", workflow: snapshot }
}

/** Workflow 工具本身报错（脚本有误、没开 Workflows……）：工作流直接失败，原因是工具返回的文字。 */
export function workflowRejected(
  state: TaskState,
  toolCallId: string,
  reason: string | undefined,
): WorkflowEvent | null {
  const current = state.workflows.get(toolCallId)
  if (!current) return null
  return update(state, compact({ ...current, status: "failed" as const, summary: reason }), true)
}

/** 这个工具调用是不是一个工作流。 */
export function isWorkflowCall(state: TaskState, toolCallId: string): boolean {
  return state.workflows.has(toolCallId)
}

/** 后台任务相关的 system 消息；不是这类消息时返回 null，交给别的分支处理。 */
export function taskEvents(state: TaskState, message: SDKMessage): AgentEvent[] | null {
  if (message.type !== "system") return null
  if (message.subtype === "task_started") {
    state.pending.add(message.task_id)
    const toolCallId = message.tool_use_id
    const current = toolCallId ? state.workflows.get(toolCallId) : undefined
    if (!toolCallId || !current) return []
    state.taskToTool.set(message.task_id, toolCallId)
    const event = update(
      state,
      compact({
        ...current,
        taskId: message.task_id,
        name: text(message.workflow_name) ?? current.name,
        description: text(message.description) ?? current.description,
      }),
    )
    return event ? [event] : []
  }
  if (message.subtype === "task_progress") {
    const current = workflowOf(state, message.task_id)
    if (!current) return []
    const progress = readProgress(record(message)?.workflow_progress)
    const event = update(
      state,
      compact({ ...current, ...progress, usage: readUsage(message.usage) ?? current.usage }),
    )
    return event ? [event] : []
  }
  if (message.subtype === "task_notification") {
    state.pending.delete(message.task_id)
    const current = workflowOf(state, message.task_id)
    if (!current) return []
    const status: WorkflowStatus =
      message.status === "completed"
        ? "completed"
        : message.status === "failed"
          ? "failed"
          : "stopped"
    const event = update(
      state,
      compact({
        ...current,
        status,
        // 结束时还在「运行中」的 agent 跟着整体状态收尾，不留转圈的行。
        agents: current.agents.map((agent) =>
          agent.state === "running" || agent.state === "queued"
            ? { ...agent, state: status === "completed" ? ("done" as const) : ("failed" as const) }
            : agent,
        ),
        usage: readUsage(message.usage) ?? current.usage,
        summary: text(message.summary),
      }),
      true,
    )
    return event ? [event] : []
  }
  if (message.subtype === "task_updated") return []
  return null
}

/** 后台任务所属的工作流当前快照。 */
function workflowOf(state: TaskState, taskId: string): WorkflowSnapshot | undefined {
  const toolCallId = state.taskToTool.get(taskId)
  return toolCallId ? state.workflows.get(toolCallId) : undefined
}

/** 还有后台任务没结束：主回合的 result 不能当成整个 run 结束。 */
export function hasPendingTasks(state: TaskState): boolean {
  return state.pending.size > 0
}
