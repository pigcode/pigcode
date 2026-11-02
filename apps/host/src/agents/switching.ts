/** 切换 Agent：同一个 Agent 优先原生 fork，换 Agent 时回退到一次性 handoff。 */
import type { Context } from "cordis"
import type { AgentSession } from "@pigcode/contracts"
import type { AgentSessionStore } from "./session-store"
import type { RegisteredAgentDriver, AgentModelInfo, AgentSettingsValues } from "./driver"

/** 取 driver 的模型目录；不支持动态目录的 Agent 返回空数组。 */
export async function listAgentModels(
  driver: RegisteredAgentDriver | undefined,
  settings: AgentSettingsValues = {},
): Promise<AgentModelInfo[]> {
  if (!driver) throw new Error("agent not found")
  return driver.listModels ? driver.listModels(settings) : []
}

/** 切换前关闭旧 Agent 的 session，避免 app-server 子进程泄漏。 */
export async function disposeSession(
  drivers: Map<string, RegisteredAgentDriver>,
  session: AgentSession,
): Promise<void> {
  const driver = drivers.get(session.agentId)
  if (!driver) return
  await driver.dispose({
    id: session.id,
    threadId: session.threadId,
    cwd: session.cwd,
    nativeSessionId: session.nativeSessionId,
    permissionMode: "workspace-write",
    model: null,
  })
}

/** 切换结果，也是 `thread.switchAgent` 的返回；换 Agent 时写 handoff，同一个 Agent 优先写原生 fork 源。 */
export interface Switch {
  agentId: string
  modelId: string | null
  /** 换 Agent 时写入的上下文摘要；使用原生 fork 时为 null。 */
  handoff: string | null
  /** 同一个 Agent 切换时的原生 fork 源；使用 handoff 时为 null。 */
  forkFromNativeSessionId: string | null
}

/** handoff 中保留的最近消息条数与工具名数量。 */
const HANDOFF_MESSAGE_LIMIT = 3
const HANDOFF_TOOL_LIMIT = 3

/** 线程最近的对话与工具名，按时间顺序。 */
function recentContext(
  ctx: Context,
  threadId: string,
): { messages: Array<{ role: string; text: string }>; tools: string[] } {
  const events = ctx.sessions.read(threadId, 0)
  const messages: Array<{ role: string; text: string }> = []
  const tools: string[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (typeof event.payload !== "object" || event.payload === null) continue
    const payload = event.payload as Record<string, unknown>
    if (event.type === "message.completed" && messages.length < HANDOFF_MESSAGE_LIMIT) {
      const role = payload.role
      const text = payload.text
      if ((role === "user" || role === "assistant") && typeof text === "string") {
        messages.push({ role, text })
      }
    }
    if (
      (event.type === "tool.completed" || event.type === "tool.started") &&
      tools.length < HANDOFF_TOOL_LIMIT
    ) {
      const name = payload.name
      if (typeof name === "string" && !tools.includes(name)) tools.push(name)
    }
    if (messages.length >= HANDOFF_MESSAGE_LIMIT && tools.length >= HANDOFF_TOOL_LIMIT) break
  }
  // 反向扫描得到的是从新到旧，输出时恢复为时间顺序。
  return { messages: messages.reverse(), tools: tools.reverse() }
}

function contextLines(context: ReturnType<typeof recentContext>): string[] {
  return [
    "Recent conversation:",
    ...(context.messages.length > 0
      ? context.messages.map((message) => `- ${message.role}: ${message.text}`)
      : ["- (none)"]),
    `Recent tools: ${context.tools.length > 0 ? context.tools.join(", ") : "(none)"}`,
  ]
}

/**
 * 生成换 Agent 时的 handoff：最近三条 user/assistant 文本与最近使用过的工具名。
 * 同一个 Agent 的切换优先原生 fork，只有无法 fork 时才走这里。
 */
export function buildHandoff(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  const previousAgent = thread?.lastAgentId ?? thread?.defaultAgentId ?? "unknown"
  return [
    `Previous agent: ${previousAgent}`,
    ...contextLines(recentContext(ctx, threadId)),
    "Continue from here. Do not repeat completed work.",
  ].join("\n")
}

/**
 * 子代理的第一条消息前附带的说明：它和主会话共用一个工作目录，并带上主会话最近的对话，
 * 让子代理知道主 agent 在做什么。主会话还没聊过时返回 null。
 */
export function buildSubagentBrief(ctx: Context, parentThreadId: string): string | null {
  if (!hasConversation(ctx, parentThreadId)) return null
  const parent = ctx.threads.get(parentThreadId)
  const mainAgent = parent?.lastAgentId ?? parent?.defaultAgentId ?? "unknown"
  return [
    `You are a sub-agent working next to the main agent (${mainAgent}) of the task "${parent?.title ?? ""}", in the same working directory.`,
    ...contextLines(recentContext(ctx, parentThreadId)),
    "Do what the user asks you below. Build on the main agent's work instead of redoing it, and avoid editing files it is changing unless asked.",
  ].join("\n")
}

/** 线程里是否已经有过对话消息。 */
function hasConversation(ctx: Context, threadId: string): boolean {
  return ctx.sessions.read(threadId, 0).some((event) => event.type === "message.completed")
}

/** 读取尚未被下一次 run 消费的 handoff；一个 handoff 只注入一次。 */
export function pendingHandoff(ctx: Context, threadId: string): string | null {
  const events = ctx.sessions.read(threadId, 0)
  let handoff: string | null = null
  let handoffSeq = -1
  for (const event of events) {
    if (event.type !== "thread.updated") continue
    if (typeof event.payload !== "object" || event.payload === null) continue
    const value = (event.payload as { handoff?: unknown }).handoff
    if (typeof value === "string" && value.length > 0) {
      handoff = value
      handoffSeq = event.seq
    }
  }
  if (handoff === null) return null
  const consumed = events.some((event) => event.type === "run.started" && event.seq > handoffSeq)
  return consumed ? null : handoff
}

/** 读取尚未被下一次 run 消费的原生 fork 源；一个 fork 只使用一次。 */
export function pendingForkFromNativeSessionId(ctx: Context, threadId: string): string | null {
  const events = ctx.sessions.read(threadId, 0)
  let forkFrom: string | null = null
  let forkSeq = -1
  for (const event of events) {
    if (event.type !== "thread.updated") continue
    if (typeof event.payload !== "object" || event.payload === null) continue
    const value = (event.payload as { forkFromNativeSessionId?: unknown }).forkFromNativeSessionId
    if (typeof value === "string" && value.length > 0) {
      forkFrom = value
      forkSeq = event.seq
    }
  }
  if (forkFrom === null) return null
  const consumed = events.some((event) => event.type === "run.started" && event.seq > forkSeq)
  return consumed ? null : forkFrom
}

/** 更新线程选择、停止旧会话并追加 thread.updated；Agent 是否存在由 registry 校验。 */
export async function switchAgent(
  ctx: Context,
  sessions: AgentSessionStore,
  threadId: string,
  agentId: string,
  modelId: string | null,
  disposeActive?: (session: AgentSession) => Promise<void>,
): Promise<Switch> {
  if (!ctx.threads.get(threadId)) throw new Error(`thread not found: ${threadId}`)
  // 同一个 Agent 且存在 active 原生会话时优先 fork；否则生成换 Agent 的 handoff。
  // 还没聊过的线程没有上下文可交接，新 agent 的第一条消息保持用户原文。
  const activeSession = sessions.findActive(threadId, agentId)
  const forkFromNativeSessionId = activeSession?.nativeSessionId ?? null
  const handoff =
    forkFromNativeSessionId === null && hasConversation(ctx, threadId)
      ? buildHandoff(ctx, threadId)
      : null
  const now = new Date().toISOString()
  const active = sessions.listByThread(threadId).filter((session) => session.status === "active")
  for (const session of active) await disposeActive?.(session)
  ctx.threads.updateSelection(threadId, agentId, modelId)
  sessions.stopActive(threadId, now)
  ctx.sessions.append({
    threadId,
    runId: null,
    type: "thread.updated",
    payload: {
      agentId,
      modelId,
      ...(forkFromNativeSessionId !== null ? { forkFromNativeSessionId } : { handoff }),
    },
    schemaVersion: 1,
    createdAt: now,
  })
  return { agentId, modelId, handoff, forkFromNativeSessionId }
}
