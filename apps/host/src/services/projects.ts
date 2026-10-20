/** 管理项目记录；路径的唯一性和归属由 SQLite 约束保证。 */
import type { Context } from "cordis"
import type { Project } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"

/** 项目记录的读写入口。 */
export interface ProjectsService {
  add(rootPath: string): Project
  list(): Project[]
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

/** 注册 projects 服务；新增项目时用目录名作为展示名。 */
export const apply: ProjectsPlugin = (ctx) => {
  const service: ProjectsService = {
    add(rootPath) {
      const project: Project = {
        id: `pr_${randomUUID()}`,
        rootPath,
        name: basename(rootPath),
        createdAt: new Date().toISOString(),
      }
      ctx.storage.db
        .prepare(`INSERT INTO projects (id, root_path, name, created_at) VALUES (?, ?, ?, ?)`)
        .run(project.id, project.rootPath, project.name, project.createdAt)
      return project
    },
    list() {
      return ctx.storage.db
        .prepare(`SELECT id, root_path, name, created_at FROM projects ORDER BY created_at ASC`)
        .all()
        .map((row) => {
          const value = row as { id: string; root_path: string; name: string; created_at: string }
          return {
            id: value.id,
            rootPath: value.root_path,
            name: value.name,
            createdAt: value.created_at,
          }
        })
    },
  }
  ctx.provide("projects", service)
}

apply.inject = inject
