/** Provider 切换：停止旧会话、更新线程选择并生成一次性 handoff。 */
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

/** 切换结果；handoff 是写给下一个 provider 的上下文。 */
export interface Switch {
  providerId: string
  modelId: string | null
  handoff: string
}

/** 选择新线程默认 provider：显式 env 优先，否则 Claude 已安装且登录时用 Claude。 */
export async function defaultProvider(): Promise<string> {
  const forced = process.env.PIGCODE_PROVIDER
  // codex 同样允许强制指定，供真实 E2E 与手动冒烟使用。
  if (forced === "claude" || forced === "codex" || forced === "fake") return forced
  const claude = await detectClaude()
  return claude.installed && claude.loggedIn ? "claude" : "fake"
}

/** 取最近一条 user 与 assistant 文本，生成固定模板的 handoff。 */
export function buildHandoff(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  const previousProvider = thread?.lastProviderId ?? thread?.defaultProviderId ?? "unknown"
  const events = ctx.sessions.read(threadId, 0)
  let user: string | null = null
  let assistant: string | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== "message.completed") continue
    if (typeof event.payload !== "object" || event.payload === null) continue
    const payload = event.payload as { role?: unknown; text?: unknown }
    if (typeof payload.text !== "string") continue
    if (payload.role === "user" && user === null) user = payload.text
    if (payload.role === "assistant" && assistant === null) assistant = payload.text
    if (user !== null && assistant !== null) break
  }
  return [
    `Previous provider: ${previousProvider}`,
    `Last user request: ${user ?? "(none)"}`,
    `Last assistant summary: ${assistant ?? "(none)"}`,
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
  const handoff = buildHandoff(ctx, threadId)
  const now = new Date().toISOString()
  const active = sessions.listByThread(threadId).filter((session) => session.status === "active")
  for (const session of active) await disposeActive?.(session)
  ctx.threads.updateSelection(threadId, providerId, modelId)
  sessions.stopActive(threadId, now)
  ctx.sessions.append({
    threadId,
    runId: null,
    type: "thread.updated",
    payload: { providerId, modelId, handoff },
    schemaVersion: 1,
    createdAt: now,
  })
  return { providerId, modelId, handoff }
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
