/** GitHub PR 服务：通过 gh CLI 查询与创建 PR，不读取或保存 GitHub token。 */
import type { Context } from "cordis"
import { pullRequestInfoSchema, type PullRequestInfo } from "@pigcode/contracts"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { threadCwd } from "./worktrees"
import { currentBranch } from "./git"

const exec = promisify(execFile)

/** gh 输出上限；PR JSON 很小，统一设置避免意外缓冲。 */
const MAX_BUFFER = 8 * 1024 * 1024

/** `gh pr view/create --json` 请求的字段，顺序与解析后的展示一致。 */
export const PR_JSON_FIELDS = "number,url,state,title,headRefName,baseRefName"

/** 执行一次 gh；参数与 cwd 都由服务解析，测试可注入 fake。 */
export type GhRunner = (args: string[], cwd: string) => Promise<string>

/** 从线程 ID 解析仓库目录；Host 只在服务注册时绑定这一层。 */
export type CwdResolver = (threadId: string) => string

/** 读取 cwd 的当前分支；detached HEAD 返回 null。 */
export type BranchReader = (cwd: string) => Promise<string | null>

/** gh 未安装时的错误码。 */
export const GH_NOT_AVAILABLE = "GH_NOT_AVAILABLE"
/** gh 未登录时的错误码。 */
export const GH_NOT_AUTHENTICATED = "GH_NOT_AUTHENTICATED"
/** gh 命令失败的通用错误码。 */
export const GH_COMMAND_FAILED = "GH_COMMAND_FAILED"

/** 找不到 gh 可执行文件；调用方可以提示安装 GitHub CLI。 */
export class GhNotAvailableError extends Error {
  readonly code = GH_NOT_AVAILABLE

  constructor() {
    super("GitHub CLI (gh) is not installed or not available on PATH")
    this.name = "GhNotAvailableError"
  }
}

/** gh 存在但未登录；错误信息里给出 gh auth login 指引。 */
export class GhNotAuthenticatedError extends Error {
  readonly code = GH_NOT_AUTHENTICATED

  constructor(detail: string) {
    super(`GitHub CLI is not authenticated. Run \`gh auth login\` first. (${detail})`)
    this.name = "GhNotAuthenticatedError"
  }
}

/** gh 命令返回非零；stderr 用于识别“分支没有 PR”等可预期的失败。 */
export class GhCommandError extends Error {
  readonly code = GH_COMMAND_FAILED
  readonly stderr: string

  constructor(detail: string) {
    super(detail.length > 0 ? detail : "gh command failed")
    this.name = "GhCommandError"
    this.stderr = detail
  }
}

/** 创建 PR 的输入；body/base 省略时使用 gh 的默认值。 */
export interface CreatePullRequestInput {
  title: string
  body?: string
  base?: string
}

/** 工作台使用的 GitHub PR 操作。 */
export interface GithubServiceInterface {
  status(threadId: string): Promise<PullRequestInfo | null>
  create(threadId: string, input: CreatePullRequestInput): Promise<PullRequestInfo>
}

declare module "cordis" {
  interface Context {
    github: GithubServiceInterface
  }
}

/** github 插件依赖的服务。 */
export const inject = ["projects", "threads", "storage"]

/** github 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface GithubPlugin {
  (ctx: Context): void
  inject: string[]
}

/** 默认 runner：直接 execFile gh；错误在服务层统一归一化。 */
export const defaultGhRunner: GhRunner = async (args, cwd) => {
  const { stdout } = await exec("gh", args, { cwd, maxBuffer: MAX_BUFFER })
  return stdout
}

/** 注册 github 服务；线程 cwd 与分支读取都留在 Host 内。 */
export const apply: GithubPlugin = (ctx) => {
  ctx.provide("github", new GithubService(defaultGhRunner, (threadId) => threadCwd(ctx, threadId)))
}

apply.inject = inject

/** gh CLI 的轻量封装；分支读取可注入，便于测试不依赖真实仓库。 */
export class GithubService implements GithubServiceInterface {
  constructor(
    private readonly run: GhRunner = defaultGhRunner,
    private readonly cwdOf: CwdResolver = () => process.cwd(),
    private readonly branchOf: BranchReader = currentBranch,
  ) {}

  /** 查询当前分支的 PR；分支不存在 PR 时返回 null。 */
  async status(threadId: string): Promise<PullRequestInfo | null> {
    const cwd = this.cwdOf(threadId)
    const branch = await this.branchOf(cwd)
    if (branch === null) return null

    try {
      const output = await this.invoke(["pr", "view", branch, "--json", PR_JSON_FIELDS], cwd)
      return parsePullRequest(output)
    } catch (error) {
      if (isNoPullRequest(error)) return null
      throw error
    }
  }

  /** 从当前分支创建 PR；body 省略时显式传空字符串，保持参数稳定。 */
  async create(threadId: string, input: CreatePullRequestInput): Promise<PullRequestInfo> {
    const title = input.title.trim()
    if (title.length === 0) throw new Error("pull request title is required")

    const cwd = this.cwdOf(threadId)
    const branch = await this.branchOf(cwd)
    if (branch === null) throw new Error("cannot create a pull request from a detached HEAD")

    const args = ["pr", "create", "--head", branch, "--title", title]
    const base = input.base?.trim()
    if (base !== undefined && base.length > 0) args.push("--base", base)
    args.push("--body", input.body ?? "", "--json", PR_JSON_FIELDS)
    return parsePullRequest(await this.invoke(args, cwd))
  }

  /** runner 的错误在这里统一转成带 code 的可读错误。 */
  private async invoke(args: string[], cwd: string): Promise<string> {
    try {
      return await this.run(args, cwd)
    } catch (error) {
      throw normalizeGhError(error)
    }
  }
}

/** 把 execFile 错误映射为 gh 领域错误；已经归一化的错误原样返回。 */
function normalizeGhError(error: unknown): Error {
  if (
    error instanceof GhNotAvailableError ||
    error instanceof GhNotAuthenticatedError ||
    error instanceof GhCommandError
  ) {
    return error
  }
  if (stringField(error, "code") === "ENOENT") return new GhNotAvailableError()

  const detail = errorDetail(error)
  if (AUTH_PATTERN.test(detail)) return new GhNotAuthenticatedError(detail)
  return new GhCommandError(detail)
}

/** 错误文本：优先 stderr，其次 Error.message。 */
function errorDetail(error: unknown): string {
  const stderr = stringField(error, "stderr")
  if (stderr !== null && stderr.trim().length > 0) return stderr.trim()
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** 读取错误对象上的字符串字段，避免使用 any。 */
function stringField(error: unknown, key: string): string | null {
  if (typeof error !== "object" || error === null || !(key in error)) return null
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

/** gh 的登录失败提示随版本变化，这里覆盖常见措辞。 */
const AUTH_PATTERN =
  /(gh auth login|not logged in|not authenticated|authentication required|bad credentials|http 401|gh_token)/i

/** gh pr view 在没有关联 PR 时的固定提示。 */
function isNoPullRequest(error: unknown): boolean {
  return /no (open )?pull requests? found/i.test(errorDetail(error))
}

/** 解析 gh --json 输出；空输出或字段不符时抛通用命令错误。 */
function parsePullRequest(output: string): PullRequestInfo {
  const trimmed = output.trim()
  if (trimmed.length === 0) throw new GhCommandError("gh returned an empty pull request payload")

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new GhCommandError("gh returned invalid JSON for pull request")
  }

  const parsed = pullRequestInfoSchema.safeParse(value)
  if (!parsed.success) throw new GhCommandError("gh returned an unexpected pull request payload")
  return parsed.data
}
