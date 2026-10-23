/** 管理项目记录；路径的唯一性和归属由 SQLite 约束保证。 */
import type { Context } from "cordis"
import type { Project } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"

/** 项目记录的读写入口。 */
export interface ProjectsService {
  /**
   * 新增项目；name 缺省或为空白时用目录名作为展示名。
   * 同一路径已在列表里时直接返回它；从侧栏移除过时恢复原记录，会话随之回来，
   * 没给新名字时沿用原来的名字。
   */
  add(rootPath: string, name?: string): Project
  /** 侧栏里的项目，不含已移除的。 */
  list(): Project[]
  /** 按 id 读取项目，已移除的也能读到，供会话解析工作目录。 */
  get(projectId: string): Project | undefined
  /** 改展示名，不动磁盘上的文件夹；已移除的项目返回 undefined。 */
  rename(projectId: string, name: string): Project | undefined
  /** 从侧栏移除：只做标记，文件夹、会话与事件都保留。 */
  remove(projectId: string): Project | undefined
}

declare module "cordis" {
  interface Context {
    projects: ProjectsService
  }
}

/** projects 插件依赖的 storage 服务。 */
export const inject = ["storage"]

/** projects 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface ProjectsPlugin {
  (ctx: Context): void
  inject: string[]
}

interface ProjectRow {
  id: string
  root_path: string
  name: string
  created_at: string
  archived_at: string | null
}

/** 注册 projects 服务。 */
export const apply: ProjectsPlugin = (ctx) => {
  const db = ctx.storage.db
  const row = (projectId: string) =>
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined

  const service: ProjectsService = {
    add(rootPath, name) {
      const given = name?.trim()
      const existing = db.prepare(`SELECT * FROM projects WHERE root_path = ?`).get(rootPath) as
        ProjectRow | undefined
      if (existing?.archived_at === null) return mapProject(existing)
      if (existing) {
        const label = given || existing.name
        db.prepare(`UPDATE projects SET archived_at = NULL, name = ? WHERE id = ?`).run(
          label,
          existing.id,
        )
        return mapProject({ ...existing, name: label })
      }
      const project: Project = {
        id: `pr_${randomUUID()}`,
        rootPath,
        name: given || basename(rootPath),
        createdAt: new Date().toISOString(),
      }
      db.prepare(`INSERT INTO projects (id, root_path, name, created_at) VALUES (?, ?, ?, ?)`).run(
        project.id,
        project.rootPath,
        project.name,
        project.createdAt,
      )
      return project
    },
    list() {
      return (
        db
          .prepare(`SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC`)
          .all() as ProjectRow[]
      ).map(mapProject)
    },
    get(projectId) {
      const value = row(projectId)
      return value ? mapProject(value) : undefined
    },
    rename(projectId, name) {
      db.prepare(`UPDATE projects SET name = ? WHERE id = ? AND archived_at IS NULL`).run(
        name,
        projectId,
      )
      const value = row(projectId)
      return value?.archived_at === null ? mapProject(value) : undefined
    },
    remove(projectId) {
      db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL`).run(
        new Date().toISOString(),
        projectId,
      )
      const value = row(projectId)
      return value ? mapProject(value) : undefined
    },
  }
  ctx.provide("projects", service)
}

apply.inject = inject

/** 把 projects 表的行映射为领域对象。 */
function mapProject(value: ProjectRow): Project {
  return {
    id: value.id,
    rootPath: value.root_path,
    name: value.name,
    createdAt: value.created_at,
  }
}
