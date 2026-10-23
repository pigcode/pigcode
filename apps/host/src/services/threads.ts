/** 管理线程记录；线程是 provider 无关的持久会话。 */
import type { Context } from "cordis"
import type { Thread } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"

/** 线程记录的读写入口。 */
export interface ThreadsService {
  /** parentThreadId 指向主会话时创建的是子代理会话，项目必须与主会话相同。 */
  create(projectId: string, title: string, providerId: string, parentThreadId?: string): Thread
  list(projectId?: string): Thread[]
  get(threadId: string): Thread | undefined
  /** 主会话下未归档的子代理，按创建时间排列。 */
  children(threadId: string): Thread[]
  /** 重命名线程；返回更新后的记录。 */
  rename(threadId: string, title: string): Thread | undefined
  /** 归档后线程不再出现在侧栏与命令面板里，事件与记录保留；子代理随主会话一起归档。 */
  archive(threadId: string): Thread | undefined
  /** 记录线程最近选择的 provider/model，切换后下一次 run 生效。 */
  updateSelection(threadId: string, providerId: string, modelId: string | null): void
  /** 修改权限模式；下一次 run 起生效，返回更新后的记录。 */
  setPermissionMode(threadId: string, mode: Thread["permissionMode"]): Thread | undefined
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

/** 注册 threads 服务；新线程默认使用 workspace-write 权限模式。 */
export const apply: ThreadsPlugin = (ctx) => {
  const service: ThreadsService = {
    create(projectId, title, providerId, parentThreadId) {
      if (parentThreadId !== undefined) {
        const parent = service.get(parentThreadId)
        if (!parent) throw new Error(`thread not found: ${parentThreadId}`)
        if (parent.projectId !== projectId) throw new Error("THREAD_PARENT_PROJECT_MISMATCH")
        // 子代理只挂在主会话下，不再嵌套。
        if (parent.parentThreadId) throw new Error("THREAD_PARENT_IS_SUBAGENT")
      }
      const now = new Date().toISOString()
      const thread: Thread = {
        id: `th_${randomUUID()}`,
        projectId,
        title,
        defaultProviderId: providerId,
        lastProviderId: null,
        lastModelId: null,
        permissionMode: "workspace-write",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        lastRunId: null,
        parentThreadId: parentThreadId ?? null,
      }
      ctx.storage.db
        .prepare(
          `INSERT INTO threads (id, project_id, title, default_provider_id, last_provider_id,
            last_model_id, permission_mode, created_at, updated_at, archived_at, last_run_id,
            parent_thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          thread.id,
          thread.projectId,
          thread.title,
          thread.defaultProviderId,
          thread.lastProviderId,
          thread.lastModelId,
          thread.permissionMode,
          thread.createdAt,
          thread.updatedAt,
          thread.archivedAt,
          thread.lastRunId,
          thread.parentThreadId,
        )
      return thread
    },
    list(projectId) {
      const rows = projectId
        ? ctx.storage.db
            .prepare(`SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC`)
            .all(projectId)
        : ctx.storage.db.prepare(`SELECT * FROM threads ORDER BY updated_at DESC`).all()
      return rows.map(mapThread)
    },
    get(threadId) {
      const row = ctx.storage.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(threadId)
      return row ? mapThread(row) : undefined
    },
    children(threadId) {
      return ctx.storage.db
        .prepare(
          `SELECT * FROM threads WHERE parent_thread_id = ? AND archived_at IS NULL
           ORDER BY created_at ASC`,
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
    updateSelection(threadId, providerId, modelId) {
      ctx.storage.db
        .prepare(
          `UPDATE threads SET last_provider_id = ?, last_model_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(providerId, modelId, new Date().toISOString(), threadId)
    },
    setPermissionMode(threadId, mode) {
      ctx.storage.db
        .prepare(`UPDATE threads SET permission_mode = ?, updated_at = ? WHERE id = ?`)
        .run(mode, new Date().toISOString(), threadId)
      return service.get(threadId)
    },
  }
  ctx.provide("threads", service)
}

apply.inject = inject

/** 把 threads 表的行映射为领域对象。 */
function mapThread(row: unknown): Thread {
  const value = row as Record<string, string | null>
  return {
    id: value.id!,
    projectId: value.project_id!,
    title: value.title!,
    defaultProviderId: value.default_provider_id!,
    lastProviderId: value.last_provider_id ?? null,
    lastModelId: value.last_model_id ?? null,
    permissionMode: value.permission_mode as Thread["permissionMode"],
    createdAt: value.created_at!,
    updatedAt: value.updated_at!,
    archivedAt: value.archived_at ?? null,
    lastRunId: value.last_run_id ?? null,
    parentThreadId: value.parent_thread_id ?? null,
  }
}
