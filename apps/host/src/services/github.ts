/** GitHub PR 服务：通过 gh CLI 查询与创建 PR，不读取或保存 GitHub token。 */
import type { Context } from "cordis"
import {
  mobilePrStatusResult,
  type MobilePrStatusResult,
  type MobilePullRequestInfo,
  type PullRequestInfo,
} from "@pigcode/contracts"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { scopeCwd, type WorkspaceScope } from "./worktrees"
import { currentBranch } from "./git"
import {
  GH_COMMAND_FAILED,
  GH_NOT_AUTHENTICATED,
  GH_NOT_AVAILABLE,
  GIT_NO_REMOTE,
  GhCommandError,
  GhNotAuthenticatedError,
  GhNotAvailableError,
  GitNoRemoteError,
  extractPullRequestNumberFromUrl,
  isNoPullRequest,
  isNotGitRepoError,
  isUnknownJsonFieldError,
  isUnknownJsonFlagError,
  normalizeGhError,
  parseDetailedPullRequest,
  parsePullRequest,
  summarizeStatusCheckRollup,
} from "./github-cli"

export {
  GH_COMMAND_FAILED,
  GH_NOT_AUTHENTICATED,
  GH_NOT_AVAILABLE,
  GIT_NO_REMOTE,
  GhCommandError,
  GhNotAuthenticatedError,
  GhNotAvailableError,
  GitNoRemoteError,
  summarizeStatusCheckRollup,
}

const exec = promisify(execFile)

/** gh 输出上限；PR JSON 很小，统一设置避免意外缓冲。 */
const MAX_BUFFER = 8 * 1024 * 1024

/** 旧版 gh 兼容回退的基础字段集（不含 isDraft）。 */
export const PR_BASE_JSON_FIELDS = "number,url,state,title,headRefName,baseRefName"

/** `gh pr view/create --json` 请求的字段，顺序与解析后的展示一致。 */
export const PR_JSON_FIELDS = `${PR_BASE_JSON_FIELDS},isDraft`

/** 手机端工作台请求的扩展 PR 字段；旧版 gh 不支持时逐级回退到 PR_JSON_FIELDS / PR_BASE_JSON_FIELDS。 */
export const PR_DETAILED_JSON_FIELDS =
  "number,url,state,title,headRefName,baseRefName,isDraft,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,updatedAt"

/** 执行一次 gh；参数与 cwd 都由服务解析，测试可注入 fake。 */
export type GhRunner = (args: string[], cwd: string) => Promise<string>

/** 从会话 id 或草稿的项目解析仓库目录；Host 只在服务注册时绑定这一层。 */
export type CwdResolver = (scope: WorkspaceScope) => string

/** 读取 cwd 的当前分支；detached HEAD 返回 null。 */
export type BranchReader = (cwd: string) => Promise<string | null>

/** 创建 PR 的输入；body/base/draft 省略时使用 gh 的默认值。 */
export interface CreatePullRequestInput {
  title: string
  body?: string
  base?: string
  draft?: boolean
}

/** 合并 PR 的输入。 */
export interface MergePullRequestInput {
  method: "merge" | "squash" | "rebase"
  deleteBranch?: boolean
}

/** 工作台使用的 GitHub PR 操作。 */
export interface GithubServiceInterface {
  /** scope 是会话 id，或者新会话草稿的项目（看项目根目录的当前分支）。 */
  status(scope: WorkspaceScope): Promise<PullRequestInfo | null>
  detailedStatus(scope: WorkspaceScope): Promise<MobilePrStatusResult>
  detailedStatusByRef(scope: WorkspaceScope, prRef: string): Promise<MobilePrStatusResult>
  create(scope: WorkspaceScope, input: CreatePullRequestInput): Promise<PullRequestInfo>
  comment(scope: WorkspaceScope, body: string): Promise<void>
  merge(scope: WorkspaceScope, input: MergePullRequestInput): Promise<PullRequestInfo>
  ready(scope: WorkspaceScope): Promise<PullRequestInfo>
  close(scope: WorkspaceScope): Promise<PullRequestInfo>
  reopen(scope: WorkspaceScope): Promise<PullRequestInfo>
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
  ctx.provide("github", new GithubService(defaultGhRunner, (scope) => scopeCwd(ctx, scope)))
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
  async status(scope: WorkspaceScope): Promise<PullRequestInfo | null> {
    const cwd = this.cwdOf(scope)
    const branch = await this.branchOf(cwd)
    if (branch === null) return null

    try {
      return await this.viewPullRequest(cwd, branch)
    } catch (error) {
      if (isNoPullRequest(error)) return null
      throw error
    }
  }

  /**
   * 手机端工作台使用的结构化 PR 状态：区分非 git 仓库、无远端、gh 未安装/未登录与无 PR，
   * 并汇总 CI 检查状态；旧版 gh 不支持扩展字段时逐级优雅回退。
   */
  async detailedStatus(scope: WorkspaceScope): Promise<MobilePrStatusResult> {
    const cwd = this.cwdOf(scope)
    let branch: string | null
    try {
      branch = await this.branchOf(cwd)
    } catch (error) {
      if (isNotGitRepoError(error)) return { status: "not-git", branch: null }
      throw error
    }
    if (branch === null) return { status: "no-pr", branch: null }

    try {
      const pr = await this.viewDetailedPullRequest(cwd, branch)
      return mobilePrStatusResult.parse({ status: "ok", branch, pr })
    } catch (error) {
      if (error instanceof GhNotAvailableError) return { status: "gh-unavailable", branch }
      if (error instanceof GhNotAuthenticatedError) return { status: "gh-unauthenticated", branch }
      if (error instanceof GitNoRemoteError) return { status: "no-remote", branch }
      if (isNotGitRepoError(error)) return { status: "not-git", branch: null }
      if (isNoPullRequest(error)) return { status: "no-pr", branch }
      throw error
    }
  }

  /** 按 PR 编号或分支名查询结构化 PR 状态（写操作后按编号刷新，即使分支已删除仍可查到）。 */
  async detailedStatusByRef(scope: WorkspaceScope, prRef: string): Promise<MobilePrStatusResult> {
    const cwd = this.cwdOf(scope)
    const pr = await this.viewDetailedPullRequest(cwd, prRef)
    const branch = (await this.branchOf(cwd).catch(() => null)) ?? pr.headRefName
    return mobilePrStatusResult.parse({ status: "ok", branch, pr })
  }

  /** 从当前分支创建 PR；body 省略时显式传空字符串，保持参数稳定。 */
  async create(scope: WorkspaceScope, input: CreatePullRequestInput): Promise<PullRequestInfo> {
    const title = input.title.trim()
    if (title.length === 0) throw new Error("pull request title is required")

    const cwd = this.cwdOf(scope)
    const branch = await this.branchOf(cwd)
    if (branch === null) throw new Error("cannot create a pull request from a detached HEAD")

    const baseArgs = ["pr", "create", "--head", branch, "--title", title]
    const base = input.base?.trim()
    if (base !== undefined && base.length > 0) baseArgs.push("--base", base)
    if (input.draft === true) baseArgs.push("--draft")
    baseArgs.push("--body", input.body ?? "")

    try {
      return parsePullRequest(await this.invoke([...baseArgs, "--json", PR_JSON_FIELDS], cwd))
    } catch (error) {
      if (isUnknownJsonFieldError(error)) {
        return parsePullRequest(
          await this.invoke([...baseArgs, "--json", PR_BASE_JSON_FIELDS], cwd),
        )
      }
      if (isUnknownJsonFlagError(error)) {
        const output = await this.invoke(baseArgs, cwd)
        const ref = extractPullRequestNumberFromUrl(output) ?? branch
        return await this.viewPullRequest(cwd, ref)
      }
      throw error
    }
  }

  /** 给当前分支关联的 PR 发表评论。 */
  async comment(scope: WorkspaceScope, body: string): Promise<void> {
    const trimmed = body.trim()
    if (trimmed.length === 0) throw new Error("pull request comment body is required")
    const cwd = this.cwdOf(scope)
    const branch = await this.requireBranch(cwd)
    await this.invoke(["pr", "comment", "--body", trimmed, "--", branch], cwd)
  }

  /** 合并当前分支的 PR：先查出 PR 编号再合并，避免 --delete-branch 后按分支名查不到 PR。 */
  async merge(scope: WorkspaceScope, input: MergePullRequestInput): Promise<PullRequestInfo> {
    const cwd = this.cwdOf(scope)
    const branch = await this.requireBranch(cwd)
    const existing = await this.viewPullRequest(cwd, branch)
    const prNumber = String(existing.number)
    const args = ["pr", "merge", `--${input.method}`]
    if (input.deleteBranch === true) args.push("--delete-branch")
    args.push("--", prNumber)
    await this.invoke(args, cwd)
    return await this.viewPullRequest(cwd, prNumber)
  }

  /** 将当前分支的草稿 PR 标记为可评审（Ready for review）。 */
  async ready(scope: WorkspaceScope): Promise<PullRequestInfo> {
    const cwd = this.cwdOf(scope)
    const branch = await this.requireBranch(cwd)
    await this.invoke(["pr", "ready", "--", branch], cwd)
    return await this.viewPullRequest(cwd, branch)
  }

  /** 关闭当前分支的 PR。 */
  async close(scope: WorkspaceScope): Promise<PullRequestInfo> {
    const cwd = this.cwdOf(scope)
    const branch = await this.requireBranch(cwd)
    await this.invoke(["pr", "close", "--", branch], cwd)
    return await this.viewPullRequest(cwd, branch)
  }

  /** 重新打开当前分支已关闭的 PR。 */
  async reopen(scope: WorkspaceScope): Promise<PullRequestInfo> {
    const cwd = this.cwdOf(scope)
    const branch = await this.requireBranch(cwd)
    await this.invoke(["pr", "reopen", "--", branch], cwd)
    return await this.viewPullRequest(cwd, branch)
  }

  private async requireBranch(cwd: string): Promise<string> {
    const branch = await this.branchOf(cwd)
    if (branch === null) {
      throw new GhCommandError("cannot perform pull request action from a detached HEAD")
    }
    return branch
  }

  private async viewPullRequest(cwd: string, ref: string): Promise<PullRequestInfo> {
    try {
      return parsePullRequest(
        await this.invoke(["pr", "view", "--json", PR_JSON_FIELDS, "--", ref], cwd),
      )
    } catch (error) {
      if (!isUnknownJsonFieldError(error)) throw error
      return parsePullRequest(
        await this.invoke(["pr", "view", "--json", PR_BASE_JSON_FIELDS, "--", ref], cwd),
      )
    }
  }

  private async viewDetailedPullRequest(cwd: string, ref: string): Promise<MobilePullRequestInfo> {
    let output: string
    try {
      output = await this.invoke(["pr", "view", "--json", PR_DETAILED_JSON_FIELDS, "--", ref], cwd)
    } catch (error) {
      if (!isUnknownJsonFieldError(error)) throw error
      try {
        output = await this.invoke(["pr", "view", "--json", PR_JSON_FIELDS, "--", ref], cwd)
      } catch (fallbackError) {
        if (!isUnknownJsonFieldError(fallbackError)) throw fallbackError
        output = await this.invoke(["pr", "view", "--json", PR_BASE_JSON_FIELDS, "--", ref], cwd)
      }
    }
    return parseDetailedPullRequest(output)
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
