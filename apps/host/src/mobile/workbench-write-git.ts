/** 手机端工作台 Worktree 与检查点写操作处理器。 */
import { basename, resolve } from "node:path"
import {
  MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
  MOBILE_WORKBENCH_LABEL_MAX,
  MOBILE_WORKBENCH_PATH_MAX,
  mobileCheckpointCreateResult,
  mobileCheckpointListResult,
  mobileCheckpointRestoreResult,
  mobileWorktreeCreateResult,
  mobileWorktreeListResult,
  mobileWorktreeRemoveResult,
  mobileWorktreeSwitchResult,
  type MobileCheckpointCreateParams,
  type MobileCheckpointCreateResult,
  type MobileCheckpointItem,
  type MobileCheckpointListParams,
  type MobileCheckpointListResult,
  type MobileCheckpointRestoreParams,
  type MobileCheckpointRestoreResult,
  type MobileWorktreeCreateParams,
  type MobileWorktreeCreateResult,
  type MobileWorktreeListParams,
  type MobileWorktreeListResult,
  type MobileWorktreeRemoveParams,
  type MobileWorktreeRemoveResult,
  type MobileWorktreeSwitchParams,
  type MobileWorktreeSwitchResult,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { Checkpoint } from "../services/checkpoints"
import { requireMobileThread } from "./command-receipts"
import { sanitizeRelativePath } from "./mentions"
import { MobileRequestError } from "./request-error"
import { assertThreadNotBusy } from "./workbench-write-helpers"

function clipText(raw: string, maxLength: number): string {
  if (raw.length <= maxLength) return raw
  const prefix = raw.slice(0, maxLength - 1)
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

function toMobileCheckpoint(item: Checkpoint): MobileCheckpointItem {
  return {
    id: item.id,
    runId: item.runId,
    phase: item.phase,
    label: item.label === null ? null : clipText(item.label, MOBILE_WORKBENCH_LABEL_MAX),
    createdAt: item.createdAt,
    restorable: item.commitSha !== null,
  }
}

export class MobileWorkbenchGitWriter {
  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
  ) {}

  private requireWorktrees() {
    const worktrees = this.ctx.get("worktrees")
    if (!worktrees) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return worktrees
  }

  private requireCheckpoints() {
    const checkpoints = this.ctx.get("checkpoints")
    if (!checkpoints) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return checkpoints
  }

  async worktreeList(params: MobileWorktreeListParams): Promise<MobileWorktreeListResult> {
    requireMobileThread(this.ctx, params.threadId)
    const worktrees = this.requireWorktrees()
    const list = await worktrees.list(params.threadId)

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    const activeResolved = list.activePath ? resolve(list.activePath) : null
    const items = list.worktrees.map((item) => ({
      id: item.id,
      name: basename(item.path) || item.id,
      branch: item.branch,
      active: activeResolved !== null && resolve(item.path) === activeResolved,
    }))
    const mainActive = activeResolved === null || !items.some((item) => item.active)
    return mobileWorktreeListResult.parse({ worktrees: items, mainActive })
  }

  async worktreeCreate(params: MobileWorktreeCreateParams): Promise<MobileWorktreeCreateResult> {
    requireMobileThread(this.ctx, params.threadId)
    assertThreadNotBusy(this.ctx, params.threadId)
    const worktrees = this.requireWorktrees()
    const created = await worktrees.create(params.threadId)

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    return mobileWorktreeCreateResult.parse({
      worktree: {
        id: created.id,
        name: basename(created.path) || created.id,
        branch: created.branch,
        active: true,
      },
    })
  }

  async worktreeSwitch(params: MobileWorktreeSwitchParams): Promise<MobileWorktreeSwitchResult> {
    requireMobileThread(this.ctx, params.threadId)
    assertThreadNotBusy(this.ctx, params.threadId)
    const worktrees = this.requireWorktrees()

    const list = await worktrees.list(params.threadId)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)
    assertThreadNotBusy(this.ctx, params.threadId)

    const target = list.worktrees.find((item) => item.id === params.worktreeId)
    if (!target) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")

    const switched = await worktrees.switch(params.threadId, target.path)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    return mobileWorktreeSwitchResult.parse({
      worktree: {
        id: switched.id,
        name: basename(switched.path) || switched.id,
        branch: switched.branch,
        active: true,
      },
    })
  }

  async worktreeRemove(params: MobileWorktreeRemoveParams): Promise<MobileWorktreeRemoveResult> {
    requireMobileThread(this.ctx, params.threadId)
    assertThreadNotBusy(this.ctx, params.threadId)
    const worktrees = this.requireWorktrees()
    if (!worktrees.activePath(params.threadId)) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }

    await worktrees.remove(params.threadId)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    return mobileWorktreeRemoveResult.parse({ removed: true })
  }

  checkpointList(params: MobileCheckpointListParams): MobileCheckpointListResult {
    requireMobileThread(this.ctx, params.threadId)
    const checkpoints = this.requireCheckpoints()
    return mobileCheckpointListResult.parse({
      checkpoints: checkpoints.list(params.threadId).map(toMobileCheckpoint),
    })
  }

  async checkpointCreate(
    params: MobileCheckpointCreateParams,
  ): Promise<MobileCheckpointCreateResult> {
    requireMobileThread(this.ctx, params.threadId)
    const checkpoints = this.requireCheckpoints()
    const label = params.label && params.label.length > 0 ? params.label : undefined
    const created = await checkpoints.create(params.threadId, label)

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    return mobileCheckpointCreateResult.parse({
      checkpoint: toMobileCheckpoint(created),
    })
  }

  async checkpointRestore(
    params: MobileCheckpointRestoreParams,
  ): Promise<MobileCheckpointRestoreResult> {
    requireMobileThread(this.ctx, params.threadId)
    assertThreadNotBusy(this.ctx, params.threadId)
    const checkpoints = this.requireCheckpoints()

    const existing = checkpoints
      .list(params.threadId)
      .find((item) => item.id === params.checkpointId)
    if (!existing || existing.commitSha === null) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }

    const affected = await checkpoints.restore(params.threadId, params.checkpointId)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    const sanitized = affected
      .map((item) => sanitizeRelativePath(item))
      .filter((item): item is string => item !== null && item.length <= MOBILE_WORKBENCH_PATH_MAX)
      .slice(0, MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT)

    return mobileCheckpointRestoreResult.parse({
      checkpointId: params.checkpointId,
      affectedCount: affected.length,
      affectedPaths: sanitized,
    })
  }
}
