/** 管理线程记录；线程是与 Agent 无关的持久会话。 */
import type { Context } from "cordis"
import {
  DEFAULT_RUNTIME_MODE,
  normalizeRuntimeMode,
  type AgentModeSelection,
  type RunStatus,
  type Thread,
  type ThreadEvent,
  type ThreadStatus,
} from "@pigcode/contracts"
import { randomUUID } from "node:crypto"

/** 算会话一次活动的事件：写入时用 touch 推进会话的更新时间。 */
export const THREAD_ACTIVITY = new Set<ThreadEvent["type"]>([
  "run.started",
  "run.completed",
  "run.failed",
  "run.interrupted",
])

/** 会话的行带上最近一次 run 的状态和结束时间；runs 按时间先后插入，rowid 最大的就是最近一次。 */
const SELECT_THREAD = `
  SELECT t.*, r.status AS run_status, r.completed_at AS run_completed_at
  FROM threads t
  LEFT JOIN runs r ON r.rowid = (SELECT MAX(rowid) FROM runs WHERE thread_id = t.id)`

/** run 的状态到会话状态；等回答和等审批一样是在等用户。 */
const STATUS_OF_RUN: Record<RunStatus, ThreadStatus> = {
  queued: "queued",
  running: "running",
  "waiting-approval": "waiting-approval",
  "waiting-input": "waiting-approval",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
}

/** 这几种状态的 run 已经结束，completed_at 是结束的时间。 */
const FINISHED = new Set<RunStatus>(["completed", "failed", "interrupted"])

/**
 * 新会话草稿里先选好的实例、模型与权限模式；写进新线程，第一次 run 就用它们。
 * instanceId 缺省时用 Agent 的默认实例。
 */
export interface InitialSelection {
  /** 为新会话预先创建 worktree 时已经分配了 id。 */
  id?: string | undefined
  instanceId?: string | undefined
  modelId?: string | undefined
  permissionMode?: Thread["permissionMode"] | undefined
  planMode?: boolean | undefined
}

/** 线程记录的读写入口。 */
export interface ThreadsService {
  /** parentThreadId 指向主会话时创建的是子代理会话，项目必须与主会话相同。 */
  create(
    projectId: string,
    title: string,
    agentId: string,
    parentThreadId?: string,
    initial?: InitialSelection,
  ): Thread
  list(projectId?: string): Thread[]
  get(threadId: string): Thread | undefined
  /** 主会话下未归档的子代理，按创建时间排列。 */
  children(threadId: string): Thread[]
  /** 重命名线程；返回更新后的记录。 */
  rename(threadId: string, title: string): Thread | undefined
  /** 归档后线程不再出现在侧栏与命令面板里，事件与记录保留；子代理随主会话一起归档。 */
  archive(threadId: string): Thread | undefined
  /** 取消归档；和主会话同一时刻归档的子代理一起回来。 */
  unarchive(threadId: string): Thread | undefined
  /** 标为已读（看过最近一次 run 的结果），或者标回未读。 */
  markRead(threadId: string, read: boolean): Thread | undefined
  /** 把所有未读的会话标为已读，返回改过的会话。 */
  markAllRead(): Thread[]
  /** 记录线程最近选择的 Agent/实例/model，切换后下一次 run 生效。 */
  updateSelection(
    threadId: string,
    agentId: string,
    modelId: string | null,
    instanceId?: string | null,
    modes?: AgentModeSelection,
  ): void
  /** 修改权限模式；下一次 run 起生效，返回更新后的记录。 */
  setPermissionMode(threadId: string, mode: Thread["permissionMode"]): Thread | undefined
  setExecutionModes(threadId: string, modes: AgentModeSelection): Thread | undefined
  /**
   * 记下线程最近一次活动（run 开始或结束）的时间和 run；侧栏按更新时间排会话、分今天昨天，
   * 不能只在改名和换 Agent 时才变。时间只往后走。
   */
  touch(threadId: string, at: string, runId: string | null): void
}

declare module "cordis" {
  interface Context {
    threads: ThreadsService
  }
}

/** threads 插件依赖的 storage 服务。 */
export const inject = ["storage"]

/** threads 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface ThreadsPlugin {
  (ctx: Context): void
  inject: string[]
}

/** 注册 threads 服务；新线程使用平台默认权限，子会话继承主会话的选择。 */
export const apply: ThreadsPlugin = (ctx) => {
  const service: ThreadsService = {
    create(projectId, title, agentId, parentThreadId, initial = {}) {
      const parent = parentThreadId ? service.get(parentThreadId) : undefined
      if (parentThreadId !== undefined) {
        if (!parent) throw new Error(`thread not found: ${parentThreadId}`)
        if (parent.projectId !== projectId) throw new Error("THREAD_PARENT_PROJECT_MISMATCH")
        // 子代理只挂在主会话下，不再嵌套。
        if (parent.parentThreadId) throw new Error("THREAD_PARENT_IS_SUBAGENT")
      }
      const now = new Date().toISOString()
      // 旧的调用方不传实例：按 Agent 的默认实例记录。
      const defaultInstanceId = initial.instanceId ?? agentId
      const thread: Thread = {
        id: initial.id ?? `th_${randomUUID()}`,
        projectId,
        title,
        defaultAgentId: agentId,
        defaultInstanceId,
        // 选了模型就和切换后一样记成最近的选择，界面和 run 都按 lastAgentId/lastModelId 读。
        lastAgentId: initial.modelId ? agentId : null,
        lastInstanceId: initial.modelId ? defaultInstanceId : null,
        lastModelId: initial.modelId ?? null,
        permissionMode:
          normalizeRuntimeMode(
            initial.permissionMode ?? parent?.permissionMode ?? DEFAULT_RUNTIME_MODE,
            agentId,
          ) ??
          initial.permissionMode ??
          parent?.permissionMode ??
          DEFAULT_RUNTIME_MODE,
        planMode:
          initial.planMode ?? (initial.permissionMode === "plan" || parent?.planMode === true),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        lastRunId: null,
        parentThreadId: parentThreadId ?? null,
        status: "idle",
        unread: false,
      }
      ctx.storage.db
        .prepare(
          `INSERT INTO threads (id, project_id, title, default_agent_id, default_instance_id,
            last_agent_id, last_instance_id, last_model_id, permission_mode, created_at, updated_at,
            archived_at, last_run_id, parent_thread_id, plan_mode, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          thread.id,
          thread.projectId,
          thread.title,
          thread.defaultAgentId,
          thread.defaultInstanceId,
          thread.lastAgentId,
          thread.lastInstanceId,
          thread.lastModelId,
          thread.permissionMode,
          thread.createdAt,
          thread.updatedAt,
          thread.archivedAt,
          thread.lastRunId,
          thread.parentThreadId,
          Number(thread.planMode),
          now,
        )
      return thread
    },
    list(projectId) {
      const rows = projectId
        ? ctx.storage.db
            .prepare(`${SELECT_THREAD} WHERE t.project_id = ? ORDER BY t.updated_at DESC`)
            .all(projectId)
        : ctx.storage.db.prepare(`${SELECT_THREAD} ORDER BY t.updated_at DESC`).all()
      return rows.map(mapThread)
    },
    get(threadId) {
      const row = ctx.storage.db.prepare(`${SELECT_THREAD} WHERE t.id = ?`).get(threadId)
      return row ? mapThread(row) : undefined
    },
    children(threadId) {
      return ctx.storage.db
        .prepare(
          `${SELECT_THREAD} WHERE t.parent_thread_id = ? AND t.archived_at IS NULL
           ORDER BY t.created_at ASC`,
        )
        .all(threadId)
        .map(mapThread)
    },
    rename(threadId, title) {
      const updatedAt = new Date().toISOString()
      ctx.storage.db
        .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
        .run(title, updatedAt, threadId)
      return service.get(threadId)
    },
    archive(threadId) {
      const now = new Date().toISOString()
      ctx.storage.db
        .prepare(
          `UPDATE threads SET archived_at = ?
           WHERE (id = ? OR parent_thread_id = ?) AND archived_at IS NULL`,
        )
        .run(now, threadId, threadId)
      return service.get(threadId)
    },
    unarchive(threadId) {
      const thread = service.get(threadId)
      if (!thread?.archivedAt) return thread
      ctx.storage.db
        .prepare(
          `UPDATE threads SET archived_at = NULL
           WHERE id = ? OR (parent_thread_id = ? AND archived_at = ?)`,
        )
        .run(threadId, threadId, thread.archivedAt)
      return service.get(threadId)
    },
    markRead(threadId, read) {
      ctx.storage.db
        .prepare(`UPDATE threads SET read_at = ? WHERE id = ?`)
        .run(read ? new Date().toISOString() : null, threadId)
      return service.get(threadId)
    },
    markAllRead() {
      const unread = service.list().filter((thread) => thread.unread)
      const now = new Date().toISOString()
      const mark = ctx.storage.db.prepare(`UPDATE threads SET read_at = ? WHERE id = ?`)
      ctx.storage.db.transaction(() => {
        for (const thread of unread) mark.run(now, thread.id)
      })()
      return unread.map((thread) => ({ ...thread, unread: false }))
    },
    updateSelection(threadId, agentId, modelId, instanceId, modes) {
      ctx.storage.db
        .prepare(
          `UPDATE threads SET last_agent_id = ?, last_instance_id = ?, last_model_id = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(agentId, instanceId ?? agentId, modelId, new Date().toISOString(), threadId)
      if (modes) service.setExecutionModes(threadId, modes)
    },
    setPermissionMode(threadId, mode) {
      const thread = service.get(threadId)
      return service.setExecutionModes(threadId, {
        permissionMode: mode,
        planMode: thread?.planMode ?? false,
      })
    },
    setExecutionModes(threadId, modes) {
      ctx.storage.db
        .prepare(
          `UPDATE threads SET permission_mode = ?, plan_mode = ?, updated_at = ? WHERE id = ?`,
        )
        .run(modes.permissionMode, Number(modes.planMode), new Date().toISOString(), threadId)
      const thread = service.get(threadId)
      return thread
    },
    touch(threadId, at, runId) {
      ctx.storage.db
        .prepare(
          `UPDATE threads SET updated_at = MAX(updated_at, ?), last_run_id = COALESCE(?, last_run_id)
           WHERE id = ?`,
        )
        .run(at, runId, threadId)
    },
  }
  ctx.provide("threads", service)
}

apply.inject = inject

/** 把 threads 表的行（带最近一次 run，见 SELECT_THREAD）映射为领域对象。 */
function mapThread(row: unknown): Thread {
  const value = row as Record<string, string | null>
  const runStatus = value.run_status as RunStatus | null
  const endedAt = runStatus && FINISHED.has(runStatus) ? (value.run_completed_at ?? null) : null
  const readAt = value.read_at ?? null
  return {
    id: value.id!,
    projectId: value.project_id!,
    title: value.title!,
    defaultAgentId: value.default_agent_id!,
    defaultInstanceId: value.default_instance_id ?? value.default_agent_id ?? null,
    lastAgentId: value.last_agent_id ?? null,
    lastInstanceId: value.last_instance_id ?? value.last_agent_id ?? null,
    lastModelId: value.last_model_id ?? null,
    permissionMode: value.permission_mode as Thread["permissionMode"],
    planMode: Number(value.plan_mode) === 1,
    createdAt: value.created_at!,
    updatedAt: value.updated_at!,
    archivedAt: value.archived_at ?? null,
    lastRunId: value.last_run_id ?? null,
    parentThreadId: value.parent_thread_id ?? null,
    status: runStatus ? STATUS_OF_RUN[runStatus] : "idle",
    unread: endedAt !== null && (readAt === null || endedAt > readAt),
  }
}
