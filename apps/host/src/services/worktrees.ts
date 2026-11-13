/** Git worktree 生命周期：创建、切换、移除，并为线程提供活动路径。 */
import type { Context } from "cordis"
import type { WorktreeStart } from "@pigcode/contracts"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, mkdtemp, realpath, rm } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { PigcodeDatabase } from "../storage/database"
import { copyWorktreeIncludes } from "./worktree-includes"

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
  prepare(projectId: string, threadId: string, start: WorktreeStart): Promise<PreparedWorktree>
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
interface WorktreeRow extends Worktree {
  cwd: string | null
}

/** Git 已创建目录，调用方可以和新会话一起登记，或者在写入失败时清理。 */
interface PreparedWorktree {
  persist(): Worktree
  rollback(): Promise<void>
}

/** 注册 worktree 服务；路径始终由项目根推导，不接受调用方传入的目标目录。 */
export const apply: WorktreesPlugin = (ctx) => {
  const creating = new Map<string, Promise<Worktree>>()
  const service: WorktreesService = {
    async list(threadId) {
      const rows = ctx.storage.db
        .prepare(
          `SELECT id, path, branch, cwd FROM worktrees WHERE thread_id = ? ORDER BY created_at, rowid`,
        )
        .all(threadId) as WorktreeRow[]
      const existing: Worktree[] = []
      for (const row of rows) {
        if (await pathExists(row.path)) existing.push(toWorktree(row))
      }
      return { worktrees: existing, activePath: activeRow(ctx.storage.db, threadId)?.path ?? null }
    },
    create(threadId) {
      const pending = creating.get(threadId)
      if (pending) return pending
      const creation = createForThread(ctx, threadId).finally(() => {
        creating.delete(threadId)
      })
      creating.set(threadId, creation)
      return creation
    },
    prepare: (projectId, threadId, start) => prepareWorktree(ctx, projectId, threadId, start),
    async switch(threadId, path) {
      const rows = ctx.storage.db
        .prepare(`SELECT id, path, branch, cwd FROM worktrees WHERE thread_id = ?`)
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

function activeWorktreeCwd(db: PigcodeDatabase, threadId: string): string | null {
  const row = activeRow(db, threadId)
  return row?.cwd ?? row?.path ?? null
}

/**
 * 文件、Git 状态、Diff 与 PR 看的是哪个目录：会话 id（会话的工作目录），或者新会话草稿的项目
 * （还没有会话，看项目根目录）。
 */
export type WorkspaceScope = string | { projectId: string }

/** 解析 WorkspaceScope 的目录；草稿只会落在侧栏里的项目上，已经移除的项目报错。 */
export function scopeCwd(
  ctx: Pick<Context, "threads" | "projects" | "storage">,
  scope: WorkspaceScope,
): string {
  if (typeof scope === "string") return threadCwd(ctx, scope)
  const project = ctx.projects.list().find((item) => item.id === scope.projectId)
  if (!project) throw new Error(`project not found: ${scope.projectId}`)
  return project.rootPath
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
  const own = activeWorktreeCwd(ctx.storage.db, threadId)
  if (own) return own
  const parent = thread.parentThreadId
    ? activeWorktreeCwd(ctx.storage.db, thread.parentThreadId)
    : null
  if (parent) return parent
  const project = ctx.projects.get(thread.projectId)
  if (!project) throw new Error(`project not found: ${thread.projectId}`)
  return project.rootPath
}

async function createForThread(ctx: Context, threadId: string): Promise<Worktree> {
  const thread = ctx.threads.get(threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  const db = ctx.storage.db
  const existing = activeRow(db, threadId)
  if (existing && (await pathExists(existing.path))) return toWorktree(existing)
  const prepared = await prepareWorktree(ctx, thread.projectId, threadId)
  try {
    return db.transaction(() => {
      if (existing) markRemoved(db, existing.id)
      return prepared.persist()
    })()
  } catch (error) {
    await prepared.rollback()
    throw error
  }
}

async function prepareWorktree(
  ctx: Context,
  projectId: string,
  threadId: string,
  start?: WorktreeStart,
): Promise<PreparedWorktree> {
  const project = ctx.projects.get(projectId)
  if (!project) throw new Error(`project not found: ${projectId}`)
  const projectPath = await realpath(project.rootPath)
  const checkoutRoot = await runGit(projectPath, ["rev-parse", "--show-toplevel"])
  const root = checkoutRoot.replace(/\r?\n$/, "")
  const subdir = relative(root, projectPath)
  const branch = `pigcode/${threadId.slice(-8)}`
  const branchRef = `refs/heads/${branch}`
  // 已有会话重新创建时复用原分支，保留上次 worktree 上的提交。
  const reuse = !start && (await refExists(root, branchRef))
  const base = reuse ? branchRef : (start?.baseRef ?? "HEAD")
  if (start?.baseRef) await runGit(root, ["check-ref-format", base])
  const commit = (
    await runGit(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])
  ).trim()
  if (subdir) {
    const object = `${commit}:${subdir.split(sep).join("/")}`
    const kind = await runGit(root, ["cat-file", "-t", object]).catch(() => "")
    if (kind.trim() !== "tree")
      throw new Error(`Project directory is missing in ${base}: ${subdir}`)
  }

  const path = await mkdtemp(join(dirname(root), `${basename(root)}-pigcode-`))
  const worktree = { id: `wt_${randomUUID()}`, path, branch }
  // 用 compare-and-swap 创建分支，回滚时只删除这次创建、且没有被移动过的分支。
  let createdBranch = false
  async function rollback() {
    try {
      await runGit(root, ["worktree", "remove", "--force", "--", path])
    } catch {
      // Git 还没登记目录时，只需要清理 mkdtemp 分配的空目录。
      await rm(path, { recursive: true, force: true })
    }
    if (createdBranch) await runGit(root, ["update-ref", "-d", branchRef, commit])
  }
  try {
    if (!reuse) {
      await runGit(root, ["update-ref", branchRef, commit, "0".repeat(commit.length)])
      createdBranch = true
    }
    await runGit(root, ["worktree", "add", "--", path, branch])
    if (start) await copyWorktreeIncludes(root, path, (args) => runGit(root, args))
  } catch (error) {
    await rollback()
    throw error
  }
  return {
    persist() {
      ctx.storage.db
        .prepare(
          `INSERT INTO worktrees
           (id, project_id, thread_id, path, branch, cwd, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          worktree.id,
          projectId,
          threadId,
          path,
          branch,
          join(path, subdir),
          new Date().toISOString(),
        )
      return worktree
    },
    rollback,
  }
}

/** 查询线程最新一条 active 行。 */
function activeRow(db: PigcodeDatabase, threadId: string): WorktreeRow | undefined {
  return db
    .prepare(
      `SELECT id, path, branch, cwd FROM worktrees
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
