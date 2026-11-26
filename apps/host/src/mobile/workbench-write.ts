/** 手机端工作台写操作处理器：单帧/分片保存文件、文件管理、Worktree、检查点与 PR 操作。 */
import {
  mobileCheckpointCreateParams,
  mobileCheckpointListParams,
  mobileCheckpointRestoreParams,
  mobilePrCloseParams,
  mobilePrCommentParams,
  mobilePrCreateParams,
  mobilePrMergeParams,
  mobilePrReadyParams,
  mobilePrReopenParams,
  mobileWorkbenchWriteMethods as methods,
  mobileWorkspaceDeletePathParams,
  mobileWorkspaceRenamePathParams,
  mobileWorkspaceWriteChunkParams,
  mobileWorkspaceWriteCommitParams,
  mobileWorktreeCreateParams,
  mobileWorktreeListParams,
  mobileWorktreeRemoveParams,
  mobileWorktreeSwitchParams,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { mobileParams, MobileRequestError } from "./request-error"
import {
  cleanupDeviceMobileWorkbenchWrites,
  MOBILE_WORKBENCH_WRITE_MAX_BUFFER_BYTES_PER_DEVICE,
  MOBILE_WORKBENCH_WRITE_MAX_SESSIONS_PER_DEVICE,
  MOBILE_WORKBENCH_WRITE_SESSION_IDLE_TTL_MS,
  MobileWorkbenchFileWriter,
  type MobileWorkbenchWriteOptions,
} from "./workbench-write-files"
import { MobileWorkbenchGitWriter } from "./workbench-write-git"
import {
  parseCreateFileParams,
  parseWriteFileParams,
  parseWriteStartParams,
} from "./workbench-write-helpers"
import { MobileWorkbenchPrWriter } from "./workbench-write-pr"

export {
  cleanupDeviceMobileWorkbenchWrites,
  MOBILE_WORKBENCH_WRITE_MAX_BUFFER_BYTES_PER_DEVICE,
  MOBILE_WORKBENCH_WRITE_MAX_SESSIONS_PER_DEVICE,
  MOBILE_WORKBENCH_WRITE_SESSION_IDLE_TTL_MS,
  type MobileWorkbenchWriteOptions,
}

export const mobileWorkbenchWriteRequests: ReadonlySet<string> = new Set(Object.values(methods))

export class MobileWorkbenchWrite {
  private readonly files: MobileWorkbenchFileWriter
  private readonly git: MobileWorkbenchGitWriter
  private readonly pr: MobileWorkbenchPrWriter

  constructor(
    ctx: Context,
    deviceKey: string,
    requirePairedDevice: () => void,
    options: MobileWorkbenchWriteOptions = {},
  ) {
    this.files = new MobileWorkbenchFileWriter(ctx, deviceKey, requirePairedDevice, options)
    this.git = new MobileWorkbenchGitWriter(ctx, requirePairedDevice)
    this.pr = new MobileWorkbenchPrWriter(ctx, requirePairedDevice)
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.writeFile:
        return this.files.writeFile(parseWriteFileParams(request.params))
      case methods.writeStart:
        return this.files.writeStart(parseWriteStartParams(request.params))
      case methods.writeChunk:
        return this.files.writeChunk(mobileParams(mobileWorkspaceWriteChunkParams, request.params))
      case methods.writeCommit:
        return this.files.writeCommit(
          mobileParams(mobileWorkspaceWriteCommitParams, request.params),
        )
      case methods.createFile:
        return this.files.createFile(parseCreateFileParams(request.params))
      case methods.renamePath:
        return this.files.renamePath(mobileParams(mobileWorkspaceRenamePathParams, request.params))
      case methods.deletePath:
        return this.files.deletePath(mobileParams(mobileWorkspaceDeletePathParams, request.params))
      case methods.worktreeList:
        return this.git.worktreeList(mobileParams(mobileWorktreeListParams, request.params))
      case methods.worktreeCreate:
        return this.git.worktreeCreate(mobileParams(mobileWorktreeCreateParams, request.params))
      case methods.worktreeSwitch:
        return this.git.worktreeSwitch(mobileParams(mobileWorktreeSwitchParams, request.params))
      case methods.worktreeRemove:
        return this.git.worktreeRemove(mobileParams(mobileWorktreeRemoveParams, request.params))
      case methods.checkpointList:
        return this.git.checkpointList(mobileParams(mobileCheckpointListParams, request.params))
      case methods.checkpointCreate:
        return this.git.checkpointCreate(mobileParams(mobileCheckpointCreateParams, request.params))
      case methods.checkpointRestore:
        return this.git.checkpointRestore(
          mobileParams(mobileCheckpointRestoreParams, request.params),
        )
      case methods.prCreate:
        return this.pr.prCreate(mobileParams(mobilePrCreateParams, request.params))
      case methods.prComment:
        return this.pr.prComment(mobileParams(mobilePrCommentParams, request.params))
      case methods.prMerge:
        return this.pr.prMerge(mobileParams(mobilePrMergeParams, request.params))
      case methods.prReady:
        return this.pr.prReady(mobileParams(mobilePrReadyParams, request.params))
      case methods.prClose:
        return this.pr.prClose(mobileParams(mobilePrCloseParams, request.params))
      case methods.prReopen:
        return this.pr.prReopen(mobileParams(mobilePrReopenParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  /** 连接断开时立即释放本连接仍在进行的分片写入会话与缓冲。 */
  close(): void {
    this.files.close()
  }

  /** 仅供撤销配对或空闲超时清理同步移除本地引用。 */
  forgetSession(sessionId: string): void {
    this.files.forgetSession(sessionId)
  }
}
