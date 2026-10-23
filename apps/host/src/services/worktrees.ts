/** Git worktree 生命周期：创建、切换、移除，并为线程提供活动路径。 */
import type { Context } from "cordis"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import type { PigcodeDatabase } from "../storage/database"

const exec = promisify(execFile)

/** 子进程输出上限；worktree 命令输出很小，统一设置避免意外缓冲。 */
const MAX_BUFFER = 8 * 1024 * 1024

/** 一条 worktree 记录；branch 为空表示创建时未记录分支。 */
export interface Worktree {
  id: string
  path: string
  branch: string | null
}

/** 线程的 worktree 列表与当前活动的那个。 */
export interface WorktreeList {
  worktrees: Worktree[]
  activePath: string | null
}

/** worktree 服务入口。 */
export interface WorktreesService {
  /** 线程创建过、目录还在的 worktree；重开应用后界面据此恢复选择。 */
  list(threadId: string): Promise<WorktreeList>
  create(threadId: string): Promise<Worktree>
  switch(threadId: string, path: string): Promise<Worktree>
  remove(threadId: string): Promise<void>
  activePath(threadId: string): string | null
}

declare module "cordis" {
  interface Context {
    worktrees: WorktreesService
  }
}

/** worktrees 插件依赖的服务。 */
export const inject = ["projects", "threads", "storage"]

/** worktrees 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface WorktreesPlugin {
  (ctx: Context): void
  inject: string[]
}

/** worktrees 表的一行。 */
interface WorktreeRow {
  id: string
  path: string
  branch: string | null
}

/** 注册 worktree 服务；路径始终由项目根推导，不接受调用方传入的目标目录。 */
export const apply: WorktreesPlugin = (ctx) => {
  const service: WorktreesService = {
    async list(threadId) {
      const rows = ctx.storage.db
        .prepare(
          `SELECT id, path, branch FROM worktrees WHERE thread_id = ? ORDER BY created_at, rowid`,
        )
        .all(threadId) as WorktreeRow[]
      const existing: Worktree[] = []
      for (const row of rows) {
        if (await pathExists(row.path)) existing.push(toWorktree(row))
      }
      return { worktrees: existing, activePath: activeRow(ctx.storage.db, threadId)?.path ?? null }
    },
    async create(threadId) {
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      const project = ctx.projects.get(thread.projectId)
      if (!project) throw new Error(`project not found: ${thread.projectId}`)

      // 重复 create 时复用仍然存在的活动 worktree，避免同一线程堆积目录。
      const existing = activeRow(ctx.storage.db, threadId)
      if (existing && (await pathExists(existing.path))) return toWorktree(existing)
      if (existing) markRemoved(ctx.storage.db, existing.id)

      // 项目目录可能是仓库子目录；worktree 放在顶层仓库的同级目录。
      const root = (await runGit(project.rootPath, ["rev-parse", "--show-toplevel"])).trim()
      const shortId = randomUUID().slice(0, 8)
      const path = join(dirname(root), `${basename(root)}-pigcode-${shortId}`)
      const branch = `pigcode/${threadId.slice(-8)}`
      await addWorktree(root, path, branch)

      const id = `wt_${randomUUID()}`
      ctx.storage.db
        .prepare(
          `INSERT INTO worktrees
           (id, project_id, thread_id, path, branch, status, created_at, removed_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .run(id, thread.projectId, threadId, path, branch, new Date().toISOString())
      return { id, path, branch }
    },
    async switch(threadId, path) {
      const rows = ctx.storage.db
        .prepare(`SELECT id, path, branch FROM worktrees WHERE thread_id = ?`)
        .all(threadId) as WorktreeRow[]
      const target = rows.find((row) => resolve(row.path) === resolve(path))
      if (!target) throw new Error(`worktree not found: ${path}`)

      // 同一线程只保留一个活动 worktree；目标行允许从 removed 重新激活。
      const now = new Date().toISOString()
      ctx.storage.db
        .prepare(
          `UPDATE worktrees SET status = 'removed', removed_at = ?
           WHERE thread_id = ? AND id <> ? AND status = 'active'`,
        )
        .run(now, threadId, target.id)
      ctx.storage.db
        .prepare(`UPDATE worktrees SET status = 'active', removed_at = NULL WHERE id = ?`)
        .run(target.id)
      return toWorktree(target)
    },
    async remove(threadId) {
      const active = activeRow(ctx.storage.db, threadId)
      if (!active) throw new Error(`worktree not found: ${threadId}`)
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      const project = ctx.projects.get(thread.projectId)
      if (!project) throw new Error(`project not found: ${thread.projectId}`)

      if (await pathExists(active.path)) {
        await runGit(project.rootPath, ["worktree", "remove", "--force", active.path])
      } else {
        // 目录已被外部删除时只清理 git 的 worktree 元数据。
        await runGit(project.rootPath, ["worktree", "prune"])
      }
      markRemoved(ctx.storage.db, active.id)
    },
    activePath(threadId) {
      return activeRow(ctx.storage.db, threadId)?.path ?? null
    },
  }
  ctx.provide("worktrees", service)
}

apply.inject = inject

/** 读取线程当前的活动 worktree 路径；供 provider cwd 解析复用同一查询。 */
export function activeWorktreePath(db: PigcodeDatabase, threadId: string): string | null {
  return activeRow(db, threadId)?.path ?? null
}

/**
 * 线程的工作目录：自己的活动 worktree > 主会话的活动 worktree（子代理与主会话共用目录）> 项目根目录。
 * agent、终端、文件树、Git 与 PR 都用它，保证它们看到的是同一个目录。
 */
export function threadCwd(
  ctx: Pick<Context, "threads" | "projects" | "storage">,
  threadId: string,
): string {
  const thread = ctx.threads.get(threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  const own = activeWorktreePath(ctx.storage.db, threadId)
  if (own) return own
  const parent = thread.parentThreadId
    ? activeWorktreePath(ctx.storage.db, thread.parentThreadId)
    : null
  if (parent) return parent
  const project = ctx.projects.get(thread.projectId)
  if (!project) throw new Error(`project not found: ${thread.projectId}`)
  return project.rootPath
}

/** 创建 worktree；移除后分支仍存在时直接复用以避免 `-b` 冲突。 */
async function addWorktree(root: string, path: string, branch: string): Promise<void> {
  if (await refExists(root, `refs/heads/${branch}`)) {
    await runGit(root, ["worktree", "add", path, branch])
    return
  }
  await runGit(root, ["worktree", "add", "-b", branch, path, "HEAD"])
}

/** 查询线程最新一条 active 行。 */
function activeRow(db: PigcodeDatabase, threadId: string): WorktreeRow | undefined {
  return db
    .prepare(
      `SELECT id, path, branch FROM worktrees
       WHERE thread_id = ? AND status = 'active'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(threadId) as WorktreeRow | undefined
}

/** 把记录标记为已移除；保留行供历史查询。 */
function markRemoved(db: PigcodeDatabase, id: string): void {
  db.prepare(`UPDATE worktrees SET status = 'removed', removed_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  )
}

/** 把数据库行映射为对外的 worktree 对象。 */
function toWorktree(row: WorktreeRow): Worktree {
  return { id: row.id, path: row.path, branch: row.branch }
}

/** 判断本地分支是否已存在；不存在或 git 报错都按不存在处理。 */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref])
    return true
  } catch {
    return false
  }
}

/** 判断路径是否存在；用于识别被外部删除的 worktree 目录。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 运行 git；所有命令都通过 execFile 直接执行，不经过 shell。 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: MAX_BUFFER })
    return stdout
  } catch (error) {
    const stderr = errorField(error, "stderr")
    const text = typeof stderr === "string" ? stderr.trim() : ""
    throw new Error(text.length > 0 ? text : `git command failed in ${cwd}`)
  }
}

/** 读取错误对象字段，避免使用 any。 */
function errorField(error: unknown, key: "stderr"): unknown {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined
  return (error as Record<string, unknown>)[key]
}
