/** 手机端工作台 PR 写操作处理器：创建、评论、就绪、关闭、重开与合并。 */
import {
  mobilePrCloseResult,
  mobilePrCommentResult,
  mobilePrCreateResult,
  mobilePrMergeResult,
  mobilePrReadyResult,
  mobilePrReopenResult,
  type MobilePrCloseParams,
  type MobilePrCloseResult,
  type MobilePrCommentParams,
  type MobilePrCommentResult,
  type MobilePrCreateParams,
  type MobilePrCreateResult,
  type MobilePrMergeParams,
  type MobilePrMergeResult,
  type MobilePrReadyParams,
  type MobilePrReadyResult,
  type MobilePrReopenParams,
  type MobilePrReopenResult,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { NotAGitRepoError } from "../services/git"
import {
  GhCommandError,
  GhNotAuthenticatedError,
  GhNotAvailableError,
  GitNoRemoteError,
} from "../services/github"
import { requireMobileThread } from "./command-receipts"
import { MobileRequestError } from "./request-error"

export class MobileWorkbenchPrWriter {
  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
  ) {}

  private requireGithub() {
    const github = this.ctx.get("github")
    if (!github) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return github
  }

  private async runPrAction<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof MobileRequestError) throw error
      if (
        error instanceof GhNotAvailableError ||
        error instanceof GhNotAuthenticatedError ||
        error instanceof GitNoRemoteError ||
        error instanceof GhCommandError ||
        error instanceof NotAGitRepoError ||
        (error instanceof Error &&
          (/detached HEAD/i.test(error.message) || /pull request/i.test(error.message)))
      ) {
        console.error("[host] mobile pr action failed", error)
        throw new MobileRequestError("PR_ACTION_FAILED")
      }
      throw error
    }
  }

  async prCreate(params: MobilePrCreateParams): Promise<MobilePrCreateResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      const created = await github.create(params.threadId, {
        title: params.title,
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.base !== undefined ? { base: params.base } : {}),
        ...(params.draft !== undefined ? { draft: params.draft } : {}),
      })
      const status = await github.detailedStatusByRef(params.threadId, String(created.number))
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrCreateResult.parse(status)
    })
  }

  async prComment(params: MobilePrCommentParams): Promise<MobilePrCommentResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      await github.comment(params.threadId, params.body)
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrCommentResult.parse({ ok: true })
    })
  }

  async prMerge(params: MobilePrMergeParams): Promise<MobilePrMergeResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      const merged = await github.merge(params.threadId, {
        method: params.method,
        ...(params.deleteBranch !== undefined ? { deleteBranch: params.deleteBranch } : {}),
      })
      const status = await github.detailedStatusByRef(params.threadId, String(merged.number))
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrMergeResult.parse(status)
    })
  }

  async prReady(params: MobilePrReadyParams): Promise<MobilePrReadyResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      const updated = await github.ready(params.threadId)
      const status = await github.detailedStatusByRef(params.threadId, String(updated.number))
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrReadyResult.parse(status)
    })
  }

  async prClose(params: MobilePrCloseParams): Promise<MobilePrCloseResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      const updated = await github.close(params.threadId)
      const status = await github.detailedStatusByRef(params.threadId, String(updated.number))
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrCloseResult.parse(status)
    })
  }

  async prReopen(params: MobilePrReopenParams): Promise<MobilePrReopenResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      const updated = await github.reopen(params.threadId)
      const status = await github.detailedStatusByRef(params.threadId, String(updated.number))
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrReopenResult.parse(status)
    })
  }
}
