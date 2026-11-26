/** gh CLI 错误归一化、错误分类与 PR JSON 解析/CI 汇总。 */
import {
  mobilePullRequestInfo,
  pullRequestInfoSchema,
  type HostErrorCode,
  type MobilePrChecksSummary,
  type MobilePullRequestInfo,
  type PullRequestInfo,
} from "@pigcode/contracts"
import { NOT_A_GIT_REPO, NotAGitRepoError } from "./git"

/** gh 未安装时的错误码。 */
export const GH_NOT_AVAILABLE = "GH_NOT_AVAILABLE" satisfies HostErrorCode
/** gh 未登录时的错误码。 */
export const GH_NOT_AUTHENTICATED = "GH_NOT_AUTHENTICATED" satisfies HostErrorCode
/** 仓库没有指向 GitHub 的远程仓库时的错误码。 */
export const GIT_NO_REMOTE = "GIT_NO_REMOTE" satisfies HostErrorCode
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

/** 仓库没有 git remote，或者 remote 都不指向 GitHub，gh 不知道要操作哪个仓库；信息保留 gh 的原文。 */
export class GitNoRemoteError extends Error {
  readonly code = GIT_NO_REMOTE

  constructor(detail: string) {
    super(detail)
    this.name = "GitNoRemoteError"
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

/** gh 的登录失败提示随版本变化，这里覆盖常见措辞。 */
const AUTH_PATTERN =
  /(gh auth login|not logged in|not authenticated|authentication required|bad credentials|http 401|gh_token)/i

/** 仓库没有 remote，或者 remote 都不指向 GitHub 时 gh 的提示。 */
const NO_REMOTE_PATTERN =
  /(no git remotes found|none of the git remotes configured for this repository point to a known github host)/i

/** 读取错误对象上的字符串字段，避免使用 any。 */
function stringField(error: unknown, key: string): string | null {
  if (typeof error !== "object" || error === null || !(key in error)) return null
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

/** 错误文本：优先 stderr，其次 Error.message。 */
function errorDetail(error: unknown): string {
  const stderr = stringField(error, "stderr")
  if (stderr !== null && stderr.trim().length > 0) return stderr.trim()
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/** 把 execFile 错误映射为 gh 领域错误；已经归一化的错误原样返回。 */
export function normalizeGhError(error: unknown): Error {
  if (
    error instanceof GhNotAvailableError ||
    error instanceof GhNotAuthenticatedError ||
    error instanceof GitNoRemoteError ||
    error instanceof GhCommandError
  ) {
    return error
  }
  if (stringField(error, "code") === "ENOENT") return new GhNotAvailableError()

  const detail = errorDetail(error)
  if (AUTH_PATTERN.test(detail)) return new GhNotAuthenticatedError(detail)
  if (NO_REMOTE_PATTERN.test(detail)) return new GitNoRemoteError(detail)
  return new GhCommandError(detail)
}

/** gh pr view 在没有关联 PR 时的固定提示。 */
export function isNoPullRequest(error: unknown): boolean {
  return /no (open )?pull requests? found/i.test(errorDetail(error))
}

/** 识别非 git 仓库错误（来自 git currentBranch 或 gh 自身输出）。 */
export function isNotGitRepoError(error: unknown): boolean {
  return (
    error instanceof NotAGitRepoError ||
    stringField(error, "code") === NOT_A_GIT_REPO ||
    /not a git repository/i.test(errorDetail(error))
  )
}

/** 旧版 gh CLI 不支持某个 `--json` 字段时的错误识别。 */
export function isUnknownJsonFieldError(error: unknown): boolean {
  return error instanceof GhCommandError && /unknown json field/i.test(error.stderr)
}

/** 某些 gh 版本 `gh pr create` 不支持 `--json` 选项时的错误识别。 */
export function isUnknownJsonFlagError(error: unknown): boolean {
  return error instanceof GhCommandError && /unknown flag:\s*--json/i.test(error.stderr)
}

/** 从 `gh pr create` 输出的 PR URL 中提取 PR 编号。 */
export function extractPullRequestNumberFromUrl(output: string): string | null {
  const match = output.match(/\/pull\/(\d+)\b/)
  return match ? match[1]! : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** 把 gh 返回的 statusCheckRollup（兼容 CheckRun 与 StatusContext）汇总为四项计数。 */
export function summarizeStatusCheckRollup(raw: unknown): MobilePrChecksSummary | undefined {
  let items: unknown[] | undefined
  if (Array.isArray(raw)) {
    items = raw
  } else if (isRecord(raw) && isRecord(raw.contexts) && Array.isArray(raw.contexts.nodes)) {
    items = raw.contexts.nodes
  }
  if (!items) return undefined

  let passed = 0
  let failed = 0
  let pending = 0

  for (const item of items) {
    if (!isRecord(item)) continue
    const typename = typeof item.__typename === "string" ? item.__typename : ""
    const hasCheckRunFields =
      typename === "CheckRun" ||
      typeof item.status === "string" ||
      typeof item.conclusion === "string"

    if (hasCheckRunFields) {
      const status = typeof item.status === "string" ? item.status.toUpperCase() : ""
      const conclusion = typeof item.conclusion === "string" ? item.conclusion.toUpperCase() : ""
      if (status.length > 0 && status !== "COMPLETED") {
        pending += 1
      } else if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
        passed += 1
      } else if (
        conclusion === "FAILURE" ||
        conclusion === "TIMED_OUT" ||
        conclusion === "CANCELLED" ||
        conclusion === "ACTION_REQUIRED" ||
        conclusion === "STARTUP_FAILURE" ||
        conclusion === "ERROR"
      ) {
        failed += 1
      } else {
        pending += 1
      }
      continue
    }

    if (typename === "StatusContext" || typeof item.state === "string") {
      const state = typeof item.state === "string" ? item.state.toUpperCase() : ""
      if (state === "SUCCESS") {
        passed += 1
      } else if (state === "FAILURE" || state === "ERROR") {
        failed += 1
      } else {
        pending += 1
      }
      continue
    }

    pending += 1
  }

  return { total: passed + failed + pending, passed, failed, pending }
}

/** 解析 gh --json 输出；空输出或字段不符时抛通用命令错误。 */
export function parsePullRequest(output: string): PullRequestInfo {
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

/** 解析扩展 PR JSON（同样兼容基础字段回退结果）。 */
export function parseDetailedPullRequest(output: string): MobilePullRequestInfo {
  const trimmed = output.trim()
  if (trimmed.length === 0) throw new GhCommandError("gh returned an empty pull request payload")

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new GhCommandError("gh returned invalid JSON for pull request")
  }

  if (!isRecord(value)) {
    throw new GhCommandError("gh returned an unexpected pull request payload")
  }

  const checksSummary = summarizeStatusCheckRollup(value.statusCheckRollup)
  const rawReview = value.reviewDecision
  const hasReview = "reviewDecision" in value
  const reviewDecision =
    rawReview === null || rawReview === ""
      ? null
      : typeof rawReview === "string"
        ? rawReview
        : undefined

  const candidate: Record<string, unknown> = {
    number: value.number,
    title: value.title,
    state: value.state,
    url: value.url,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    ...(typeof value.isDraft === "boolean" ? { isDraft: value.isDraft } : {}),
    ...(isNonNegativeInt(value.additions) ? { additions: value.additions } : {}),
    ...(isNonNegativeInt(value.deletions) ? { deletions: value.deletions } : {}),
    ...(isNonNegativeInt(value.changedFiles) ? { changedFiles: value.changedFiles } : {}),
    ...(hasReview && reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(checksSummary !== undefined ? { checksSummary } : {}),
    ...(typeof value.updatedAt === "string" && value.updatedAt.length > 0
      ? { updatedAt: value.updatedAt }
      : {}),
  }

  const parsed = mobilePullRequestInfo.safeParse(candidate)
  if (!parsed.success) throw new GhCommandError("gh returned an unexpected pull request payload")
  return parsed.data
}
