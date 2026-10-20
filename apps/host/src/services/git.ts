/** Git 服务：状态、diff 与隐藏 ref checkpoint；所有命令都通过 execFile 直接执行。 */
import type { Context } from "cordis"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** 子进程输出上限，避免一次性读取超大 diff。 */
const MAX_BUFFER = 32 * 1024 * 1024
/** checkpoint ref 的固定前缀。 */
const CHECKPOINT_PREFIX = "refs/pigcode/checkpoints"
/** 临时 git index 文件名前缀。 */
const INDEX_PREFIX = "pigcode-index-"
/** 无法识别的 git 仓库时使用的错误码。 */
export const NOT_A_GIT_REPO = "NOT_A_GIT_REPO"

/** 一条工作区变更；status 保留 porcelain 的两位状态码。 */
export interface GitChange {
  path: string
  status: string
}

/** 工作区状态；detached HEAD 时 branch 为 null。 */
export interface GitStatus {
  branch: string | null
  changed: GitChange[]
}

/** 一次 checkpoint 产生的隐藏 ref 与提交。 */
export interface CheckpointRef {
  ref: string
  commitSha: string
}

/** 工作台需要的 Git 操作。 */
export interface GitService {
  status(threadId: string): Promise<GitStatus>
  diff(threadId: string, base: string, head: string): Promise<string>
  capture(threadId: string, runId: string, phase: string): Promise<CheckpointRef>
  restore(threadId: string, commitSha: string): Promise<string[]>
}

declare module "cordis" {
  interface Context {
    git: GitService
  }
}

/** git 插件依赖的服务。 */
export const inject = ["projects", "threads"]

/** git 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface GitPlugin {
  (ctx: Context): void
  inject: string[]
}

/** 非 git 仓库错误；调用方可以用 code 区分。 */
export class NotAGitRepoError extends Error {
  readonly code = NOT_A_GIT_REPO

  constructor(cwd: string) {
    super(`${NOT_A_GIT_REPO}: ${cwd}`)
    this.name = "NotAGitRepoError"
  }
}

/** 注册 git 服务；线程 ID 在这里解析为项目根目录，共享函数仍接收 cwd。 */
export const apply: GitPlugin = (ctx) => {
  const service: GitService = {
    status: (threadId) => status(projectRoot(ctx, threadId)),
    diff: (threadId, base, head) => diff(projectRoot(ctx, threadId), base, head),
    capture: (threadId, runId, phase) =>
      capture(projectRoot(ctx, threadId), threadId, runId, phase),
    restore: (threadId, commitSha) => restore(projectRoot(ctx, threadId), commitSha),
  }
  ctx.provide("git", service)
}

apply.inject = inject

/** 解析线程对应的项目根目录；Task 5 引入 worktree 后再切换到活动 worktree。 */
function projectRoot(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  const project = ctx.projects.list().find((item) => item.id === thread.projectId)
  if (!project) throw new Error(`project not found: ${thread.projectId}`)
  return project.rootPath
}

/** 读取 porcelain 状态；分支名单独查询，detached HEAD 返回 null。 */
export async function status(cwd: string): Promise<GitStatus> {
  const [output, branch] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "-z"]),
    currentBranch(cwd),
  ])
  return { branch, changed: parseStatus(output) }
}

/** 解析 `git status --porcelain=v1 -z` 输出；重命名条目会多带一个原路径记录。 */
export function parseStatus(output: string): GitChange[] {
  const records = output.split("\0")
  const changed: GitChange[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length < 4) continue
    const statusCode = record.slice(0, 2)
    changed.push({ path: toPosix(record.slice(3)), status: statusCode })
    if (isRenameOrCopy(statusCode)) index += 1
  }
  return changed
}

/** 返回 base 到 head 的文本 diff；没有差异时返回空字符串。 */
export async function diff(cwd: string, base: string, head: string): Promise<string> {
  assertRevision(base, "base")
  assertRevision(head, "head")
  return runGit(cwd, ["diff", "--no-color", base, head, "--"])
}

/** 用临时 index 把工作区（含未跟踪文件）写成提交并更新隐藏 ref，不触碰用户索引。 */
export async function capture(
  cwd: string,
  threadId: string,
  runId: string,
  phase: string,
): Promise<CheckpointRef> {
  assertRefComponent(threadId, "threadId")
  assertRefComponent(runId, "runId")
  assertRefComponent(phase, "phase")
  const ref = `${CHECKPOINT_PREFIX}/${threadId}/${runId}/${phase}`
  const indexFile = join(tmpdir(), `${INDEX_PREFIX}${randomUUID()}`)

  try {
    const env = { GIT_INDEX_FILE: indexFile }
    await runGit(cwd, ["add", "-A"], env)
    const tree = (await runGit(cwd, ["write-tree"], env)).trim()
    const parent = await headCommit(cwd)
    const args = ["commit-tree", tree]
    if (parent) args.push("-p", parent)
    args.push("-m", "pigcode checkpoint")
    const commitSha = (await runGit(cwd, args)).trim()
    await runGit(cwd, ["update-ref", ref, commitSha])
    return { ref, commitSha }
  } finally {
    await rm(indexFile, { force: true })
  }
}

/** 恢复工作区与索引到指定提交，并清理未跟踪文件；返回受影响路径。 */
export async function restore(cwd: string, commitSha: string): Promise<string[]> {
  assertRevision(commitSha, "commitSha")
  const affected = await affectedPaths(cwd, commitSha)
  await runGit(cwd, ["restore", `--source=${commitSha}`, "--worktree", "--staged", "--", "."])
  await runGit(cwd, ["clean", "-fd"])
  return affected
}

/** 在恢复前记录将被改动的路径，包含未跟踪文件以便 UI 提示。 */
async function affectedPaths(cwd: string, commitSha: string): Promise<string[]> {
  const [diffOutput, untrackedOutput] = await Promise.all([
    runGit(cwd, ["diff", "--name-only", commitSha, "--"]),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])
  const paths = new Set<string>()
  for (const line of diffOutput.split(/\r?\n/)) {
    if (line.length > 0) paths.add(toPosix(line))
  }
  for (const path of untrackedOutput.split("\0")) {
    if (path.length > 0) paths.add(toPosix(path))
  }
  return [...paths]
}

/** 运行 git；exit 1 等预期失败在调用侧用 runGitOrNull 处理。 */
async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: env ? { ...process.env, ...env } : process.env,
    })
    return stdout
  } catch (error) {
    throw normalizeGitError(error, cwd)
  }
}

/** 允许失败的 git 调用；非 git 仓库仍然抛错，其余返回 null。 */
async function runGitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args)
  } catch (error) {
    if (error instanceof NotAGitRepoError) throw error
    return null
  }
}

/** 当前分支名；unborn 分支也能返回名称，detached HEAD 返回 null。 */
async function currentBranch(cwd: string): Promise<string | null> {
  const output = await runGitOrNull(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
  return output === null ? null : output.trim() || null
}

/** HEAD 提交；空仓库返回 null，checkpoint 就作为根提交。 */
async function headCommit(cwd: string): Promise<string | null> {
  const output = await runGitOrNull(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])
  return output === null ? null : output.trim() || null
}

/** 把 execFile 错误转换为带错误码的 Error，便于上层识别非 git 仓库。 */
function normalizeGitError(error: unknown, cwd: string): Error {
  const stderr = errorField(error, "stderr")
  const text = typeof stderr === "string" ? stderr.trim() : ""
  if (text.includes("not a git repository")) return new NotAGitRepoError(cwd)
  return new Error(text.length > 0 ? text : `git command failed in ${cwd}`)
}

/** 读取错误对象字段，避免使用 any。 */
function errorField(error: unknown, key: "stderr"): unknown {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined
  return (error as Record<string, unknown>)[key]
}

/** 状态码包含 R 或 C 表示重命名/复制，解析时要跳过紧随其后的原路径。 */
function isRenameOrCopy(statusCode: string): boolean {
  return /[RC]/.test(statusCode)
}

/** 拒绝以短横线开头或包含换行的 revision，避免参数注入。 */
function assertRevision(value: string, label: string): void {
  if (value.length === 0 || value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`)
  }
}

/** ref 由线程、run 与阶段拼接，逐段校验以阻止 `..` 或非法 ref 字符逃逸命名空间。 */
function assertRefComponent(value: string, label: string): void {
  const invalid =
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("@{") ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    /[\u0000-\u0020~^:?*[\]\u007f]/.test(value)
  if (invalid) throw new Error(`invalid ${label}: ${value}`)
}

/** 把平台路径分隔符统一为 `/`，供 RPC 和 UI 使用。 */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}
