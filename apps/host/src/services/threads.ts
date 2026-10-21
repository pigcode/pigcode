/** 管理线程记录；线程是 provider 无关的持久会话。 */
import type { Context } from "cordis"
import type { Thread } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"

/** 线程记录的读写入口。 */
export interface ThreadsService {
  create(projectId: string, title: string, providerId: string): Thread
  list(projectId?: string): Thread[]
  get(threadId: string): Thread | undefined
  /** 重命名线程；返回更新后的记录。 */
  rename(threadId: string, title: string): Thread | undefined
  /** 记录线程最近选择的 provider/model，切换后下一次 run 生效。 */
  updateSelection(threadId: string, providerId: string, modelId: string | null): void
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
    create(projectId, title, providerId) {
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
      }
      ctx.storage.db
        .prepare(
          `INSERT INTO threads (id, project_id, title, default_provider_id, last_provider_id,
            last_model_id, permission_mode, created_at, updated_at, archived_at, last_run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    rename(threadId, title) {
      const updatedAt = new Date().toISOString()
      ctx.storage.db
        .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
        .run(title, updatedAt, threadId)
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
  }
}
