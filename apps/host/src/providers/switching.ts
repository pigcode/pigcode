/** Provider 切换：同 provider 优先原生 fork，跨 provider 回退到一次性 handoff。 */
import type { Context } from "cordis"
import type { ProviderSession } from "@pigcode/contracts"
import { activeWorktreePath } from "../services/worktrees"
import { detectClaude } from "./claude/detect"
import type { ProviderSessionStore } from "./claude/session-store"
import type { ProviderDriver, ProviderModelInfo } from "./driver"

/** 取 driver 的模型目录；不支持动态目录的 provider 返回空数组。 */
export async function listProviderModels(
  driver: ProviderDriver | undefined,
): Promise<ProviderModelInfo[]> {
  if (!driver) throw new Error("provider not found")
  return driver.listModels ? driver.listModels() : []
}

/** 切换前关闭旧 provider 的 session，避免 app-server 子进程泄漏。 */
export async function disposeSession(
  drivers: Map<string, ProviderDriver>,
  session: ProviderSession,
): Promise<void> {
  const driver = drivers.get(session.providerId)
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

/** 切换结果；跨 provider 写 handoff，同 provider 优先写原生 fork 源。 */
export interface Switch {
  providerId: string
  modelId: string | null
  /** 跨 provider 切换时写入的上下文摘要；使用原生 fork 时为 null。 */
  handoff: string | null
  /** 同 provider 切换时的原生 fork 源；使用 handoff 时为 null。 */
  forkFromNativeSessionId: string | null
}

/** 选择新线程默认 provider：显式 env 指向已注册 provider 时优先，否则 Claude 已安装且登录时用 Claude。 */
export async function defaultProvider(hasProvider: (id: string) => boolean): Promise<string> {
  const forced = process.env.PIGCODE_PROVIDER
  // 第三方 provider 插件注册后同样允许强制指定，供 E2E 与手动冒烟使用。
  if (forced && hasProvider(forced)) return forced
  const claude = await detectClaude()
  return claude.installed && claude.loggedIn ? "claude" : "fake"
}

/** handoff 中保留的最近消息条数与工具名数量。 */
const HANDOFF_MESSAGE_LIMIT = 3
const HANDOFF_TOOL_LIMIT = 3

/**
 * 生成跨 provider 的 handoff：最近三条 user/assistant 文本与最近使用过的工具名。
 * 同一 provider 的切换优先原生 fork，只有无法 fork 时才走这里。
 */
export function buildHandoff(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  const previousProvider = thread?.lastProviderId ?? thread?.defaultProviderId ?? "unknown"
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
  const recentMessages = messages.reverse()
  const recentTools = tools.reverse()
  return [
    `Previous provider: ${previousProvider}`,
    "Recent conversation:",
    ...(recentMessages.length > 0
      ? recentMessages.map((message) => `- ${message.role}: ${message.text}`)
      : ["- (none)"]),
    `Recent tools: ${recentTools.length > 0 ? recentTools.join(", ") : "(none)"}`,
    "Continue from here. Do not repeat completed work.",
  ].join("\n")
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

/** 更新线程选择、停止旧会话并追加 thread.updated；provider 是否存在由 registry 校验。 */
export async function switchProvider(
  ctx: Context,
  sessions: ProviderSessionStore,
  threadId: string,
  providerId: string,
  modelId: string | null,
  disposeActive?: (session: ProviderSession) => Promise<void>,
): Promise<Switch> {
  if (!ctx.threads.get(threadId)) throw new Error(`thread not found: ${threadId}`)
  // 同 provider 且存在 active 原生会话时优先 fork；否则生成跨 provider 的 handoff。
  const activeSession = sessions.findActive(threadId, providerId)
  const forkFromNativeSessionId = activeSession?.nativeSessionId ?? null
  const handoff = forkFromNativeSessionId === null ? buildHandoff(ctx, threadId) : null
  const now = new Date().toISOString()
  const active = sessions.listByThread(threadId).filter((session) => session.status === "active")
  for (const session of active) await disposeActive?.(session)
  ctx.threads.updateSelection(threadId, providerId, modelId)
  sessions.stopActive(threadId, now)
  ctx.sessions.append({
    threadId,
    runId: null,
    type: "thread.updated",
    payload: {
      providerId,
      modelId,
      ...(forkFromNativeSessionId !== null ? { forkFromNativeSessionId } : { handoff }),
    },
    schemaVersion: 1,
    createdAt: now,
  })
  return { providerId, modelId, handoff, forkFromNativeSessionId }
}

/** 解析线程的 provider cwd：优先活动 worktree，没有时回退到项目根目录。 */
export function resolveThreadCwd(ctx: Context, threadId: string, projectId: string): string {
  const worktree = activeWorktreePath(ctx.storage.db, threadId)
  if (worktree) return worktree
  const row = ctx.storage.db
    .prepare(`SELECT root_path FROM projects WHERE id = ?`)
    .get(projectId) as { root_path: string } | undefined
  return row?.root_path ?? process.cwd()
}
