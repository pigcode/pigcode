/** 切换 Agent：同一个 Agent 优先原生 fork，换 Agent 时回退到一次性 handoff。 */
import type { Context } from "cordis"
import type { AgentSession } from "@pigcode/contracts"
import type { AgentSessionStore } from "./session-store"
import { HandoffStore, type NewHandoff } from "../storage/handoff-store"
import { ThreadItemStore } from "../storage/thread-items"
import {
  buildSelection,
  handoffBudget,
  type HandoffSelection,
  type TargetContext,
} from "./handoff-builder"
import type { AgentDriver, AgentModelInfo, AgentSettingsValues } from "./driver"

/** 取 driver 的模型目录；不支持动态目录的 Agent 返回空数组。 */
export async function listAgentModels(
  driver: AgentDriver | undefined,
  settings: AgentSettingsValues = {},
): Promise<AgentModelInfo[]> {
  if (!driver) throw new Error("agent not found")
  return driver.listModels ? driver.listModels(settings) : []
}

/** 切换前关闭旧 Agent 的 session，避免 app-server 子进程泄漏。 */
export async function disposeSession(
  drivers: Map<string, AgentDriver>,
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
  /** 切换后使用的实例；没有实例信息时等于 agentId（默认实例）。 */
  instanceId: string
  modelId: string | null
  /** 换 Agent 时写入的上下文摘要；使用原生 fork 时为 null。 */
  handoff: string | null
  /** 同一个 Agent 切换时的原生 fork 源；使用 handoff 时为 null。 */
  forkFromNativeSessionId: string | null
}

/**
 * 从会话条目里按预算挑出要交接的内容（#79）。excludeRunId 那一轮自己的输入会原样发出，不放进交接；
 * afterPosition 用来只交接某个位置之后的增量。没有可交接的条目时返回 null。
 */
export function composeHandoff(
  ctx: Context,
  threadId: string,
  options: {
    heading: string
    excludeRunId?: string
    afterPosition?: number
    target?: TargetContext | null
    userText?: string
    tokenCap?: number
  },
): HandoffSelection | null {
  const items = new ThreadItemStore(ctx.storage.db).list(threadId, {
    ...(options.afterPosition !== undefined ? { afterPosition: options.afterPosition } : {}),
    ...(options.excludeRunId !== undefined ? { excludeRunId: options.excludeRunId } : {}),
  })
  return buildSelection({
    items,
    heading: options.heading,
    threadId,
    budget: handoffBudget({
      target: options.target ?? null,
      userText: options.userText ?? "",
      ...(options.tokenCap !== undefined ? { tokenCap: options.tokenCap } : {}),
    }),
  })
}

/** 交接开头那一行：之前是哪个（些）Agent 在做。 */
function previousAgentsLine(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  const previous =
    thread?.lastInstanceId ?? thread?.lastAgentId ?? thread?.defaultAgentId ?? "unknown"
  return `Context handoff: this conversation was carried on by ${previous} before you joined. Continue from here; do not repeat completed work.`
}

/** 增量交接开头那一行：接回原来的会话，下面是离开以后发生的事。 */
function deltaLine(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  const previous = thread?.lastInstanceId ?? thread?.lastAgentId ?? "another agent"
  return `Context handoff: you are back in your earlier session of this conversation. While you were away, ${previous} continued it; below is what happened since you left. Continue from here; do not repeat completed work.`
}

/** 子代理的说明最多 6k token：它主要做自己的事，主会话的近况只是背景。 */
const SUBAGENT_BRIEF_TOKENS = 6_000

/**
 * 子代理的第一条消息前附带的说明：它和主会话共用一个工作目录，并带上主会话按预算挑出的历史，
 * 让子代理知道主 agent 在做什么。主会话还没聊过时返回 null。
 */
export function buildSubagentBrief(ctx: Context, parentThreadId: string): HandoffSelection | null {
  const parent = ctx.threads.get(parentThreadId)
  const mainAgent =
    parent?.lastInstanceId ?? parent?.lastAgentId ?? parent?.defaultAgentId ?? "unknown"
  return composeHandoff(ctx, parentThreadId, {
    heading: [
      `You are a sub-agent working next to the main agent (${mainAgent}) of the task "${parent?.title ?? ""}", in the same working directory.`,
      "Do what the user asks you below. Build on the main agent's work instead of redoing it, and avoid editing files it is changing unless asked.",
    ].join("\n"),
    tokenCap: SUBAGENT_BRIEF_TOKENS,
  })
}

/**
 * 给刚建好的子代理会话记一份说明（主会话的近况），第一条消息时带上；主会话还没聊过时什么也不做。
 * 事件里只带交接记录的 id，时间线据此在子代理会话开头画一行说明。
 */
export function recordSubagentBrief(ctx: Context, threadId: string, parentThreadId: string): void {
  const brief = buildSubagentBrief(ctx, parentThreadId)
  if (!brief) return
  const record = new HandoffStore(ctx.storage.db).create({
    threadId,
    strategy: "subagent_brief",
    ...brief,
  })
  ctx.sessions.append({
    threadId,
    runId: null,
    type: "thread.updated",
    payload: { handoffId: record.id, handoffStrategy: record.strategy },
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  })
}

/**
 * 原生会话接不上（resume 失败）、这一轮改开新会话时带的交接：这一轮之前的对话。
 * 这一轮之前还没聊过时返回 null。
 */
export function freshSessionHandoff(
  ctx: Context,
  threadId: string,
  runId: string,
  userText: string,
  toInstanceId?: string,
): NewHandoff | null {
  const selection = composeHandoff(ctx, threadId, {
    heading:
      "Context handoff: the agent's previous session for this conversation could not be resumed, so this is a new session. Continue from here; do not repeat completed work.",
    excludeRunId: runId,
    userText,
  })
  return selection === null
    ? null
    : {
        threadId,
        strategy: "fresh_session",
        ...selection,
        ...(toInstanceId ? { toInstanceId } : {}),
      }
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

/** 更新线程选择、停止旧会话并追加 thread.updated；Agent 与实例是否存在由 registry 校验。 */
export async function switchAgent(
  ctx: Context,
  sessions: AgentSessionStore,
  threadId: string,
  agentId: string,
  modelId: string | null,
  disposeActive?: (session: AgentSession) => Promise<void>,
  instanceId?: string | null,
  /** 实例的原生会话放在哪里（driver.continuationKey）；值相同的实例能接着用彼此的原生会话（#82）。 */
  keyFor?: (instanceId: string) => string | null,
): Promise<Switch> {
  if (!ctx.threads.get(threadId)) throw new Error(`thread not found: ${threadId}`)
  const chosenInstance = instanceId ?? agentId
  // 三种接法（#78）：
  // - 同一个实例、原生会话还在用（只换模型）：原生 fork，不需要交接；
  // - 这个实例在这个会话里用过、原生会话停放着：下一轮接回它，只交接它离开之后发生的事；
  // - 同一个 Agent 的另一个实例用过、配置目录相同：fork 它的原生会话，也只交接增量（#82）；
  // - 都没有：新会话，交接整个会话。
  // 还没聊过的线程没有上下文可交接，新 agent 的第一条消息保持用户原文。
  const activeSession = sessions.findActive(threadId, agentId, chosenInstance)
  const forkFromNativeSessionId = activeSession?.nativeSessionId ?? null
  const parked =
    forkFromNativeSessionId === null
      ? sessions.findResumable(threadId, agentId, chosenInstance)
      : undefined
  const shared =
    forkFromNativeSessionId === null && !parked && keyFor
      ? findShared(sessions.listByThread(threadId), agentId, chosenInstance, keyFor)
      : undefined
  const source = parked ?? shared
  const since = source
    ? new ThreadItemStore(ctx.storage.db).lastPositionOfSession(threadId, source.id)
    : null
  const resumed = source !== undefined && since !== null
  // 别的实例的原生会话不接回来（那是它自己的），fork 一份给这个实例。
  const forkFrom =
    forkFromNativeSessionId ?? (shared && resumed ? (shared.nativeSessionId ?? null) : null)
  const selection =
    forkFromNativeSessionId !== null
      ? null
      : resumed
        ? composeHandoff(ctx, threadId, { heading: deltaLine(ctx, threadId), afterPosition: since })
        : composeHandoff(ctx, threadId, { heading: previousAgentsLine(ctx, threadId) })
  const handoff = selection?.text ?? null
  const now = new Date().toISOString()
  const previous = ctx.threads.get(threadId)
  const previousInstance = previous?.lastInstanceId ?? previous?.defaultInstanceId ?? null
  const active = sessions.listByThread(threadId).filter((session) => session.status === "active")
  for (const session of active) await disposeActive?.(session)
  ctx.threads.updateSelection(threadId, agentId, modelId, chosenInstance)
  // 子进程关了，原生会话留着：切回来时接着用。
  sessions.parkActive(threadId, now)
  // 交接记在 thread_handoffs 里，下一轮发送时带上；事件里只留它的 id，时间线据此画切换标记。
  // 之前切换留下、还没发出去的交接是给别的实例的，先作废。
  const handoffs = new HandoffStore(ctx.storage.db)
  handoffs.supersedeSwitches(threadId)
  const record =
    selection === null
      ? null
      : handoffs.create({
          threadId,
          strategy: resumed ? "switch_delta" : "switch",
          ...selection,
          fromInstanceIds: previousInstance ? [previousInstance] : [],
          toInstanceId: chosenInstance,
        })
  ctx.sessions.append({
    threadId,
    runId: null,
    type: "thread.updated",
    payload: {
      agentId,
      instanceId: chosenInstance,
      modelId,
      ...(forkFrom !== null ? { forkFromNativeSessionId: forkFrom } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(record
        ? {
            handoffId: record.id,
            handoffItems: record.selectedItemIds.length,
            handoffOmitted: record.omittedCount,
          }
        : {}),
    },
    schemaVersion: 1,
    createdAt: now,
  })
  return {
    agentId,
    instanceId: chosenInstance,
    modelId,
    handoff,
    forkFromNativeSessionId: forkFrom,
  }
}

/**
 * 同一个 Agent 的其他实例在这个会话里留下的、原生会话和目标实例放在同一处的最近一个会话。
 */
function findShared(
  rows: readonly AgentSession[],
  agentId: string,
  instanceId: string,
  keyFor: (instanceId: string) => string | null,
): AgentSession | undefined {
  const target = keyFor(instanceId)
  if (!target) return undefined
  return [...rows]
    .reverse()
    .find(
      (row) =>
        row.agentId === agentId &&
        (row.instanceId ?? row.agentId) !== instanceId &&
        row.nativeSessionId !== null &&
        row.status !== "stopped" &&
        keyFor(row.instanceId ?? row.agentId) === target,
    )
}
