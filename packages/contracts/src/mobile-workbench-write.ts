/** 手机端工作台写操作（文件保存与管理、Worktree、检查点与 PR 操作）的协议定义。 */
import { z } from "zod"
import {
  MOBILE_WORKBENCH_PATH_MAX,
  mobilePrStatusResult,
  mobileWorkspaceFileEol,
} from "./mobile-workbench"

export const MOBILE_WORKBENCH_WRITE_INLINE_MAX = 32 * 1024
export const MOBILE_WORKBENCH_WRITE_CHUNK_BYTES = 24 * 1024
export const MOBILE_WORKBENCH_WRITE_MAX_BYTES = 1024 * 1024
export const MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT = 50
export const MOBILE_WORKBENCH_LABEL_MAX = 200
export const MOBILE_WORKBENCH_PR_TITLE_MAX = 256
export const MOBILE_WORKBENCH_PR_BODY_MAX = 32 * 1024

const MOBILE_WORKBENCH_SESSION_ID_MAX = 128
const MOBILE_WORKBENCH_WRITE_CHUNK_BASE64_MAX =
  Math.ceil(MOBILE_WORKBENCH_WRITE_CHUNK_BYTES / 3) * 4

export const mobileWorkbenchWriteMethods = {
  writeFile: "mobile.workspace.writeFile",
  writeStart: "mobile.workspace.writeStart",
  writeChunk: "mobile.workspace.writeChunk",
  writeCommit: "mobile.workspace.writeCommit",
  createFile: "mobile.workspace.createFile",
  renamePath: "mobile.workspace.renamePath",
  deletePath: "mobile.workspace.deletePath",
  worktreeList: "mobile.worktree.list",
  worktreeCreate: "mobile.worktree.create",
  worktreeSwitch: "mobile.worktree.switch",
  worktreeRemove: "mobile.worktree.remove",
  checkpointList: "mobile.checkpoint.list",
  checkpointCreate: "mobile.checkpoint.create",
  checkpointRestore: "mobile.checkpoint.restore",
  prCreate: "mobile.pr.create",
  prComment: "mobile.pr.comment",
  prMerge: "mobile.pr.merge",
  prReady: "mobile.pr.ready",
  prClose: "mobile.pr.close",
  prReopen: "mobile.pr.reopen",
} as const

const encoder = new TextEncoder()

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

const key = z.string().min(1)
const sessionIdSchema = z.string().min(1).max(MOBILE_WORKBENCH_SESSION_ID_MAX)
const pathSchema = z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

const inlineWriteTextSchema = z
  .string()
  .max(MOBILE_WORKBENCH_WRITE_INLINE_MAX)
  .refine((value) => utf8ByteLength(value) <= MOBILE_WORKBENCH_WRITE_INLINE_MAX, {
    message: "text exceeds inline UTF-8 limit of 32 KiB",
  })

const writeChunkBase64Schema = z
  .string()
  .min(1)
  .max(MOBILE_WORKBENCH_WRITE_CHUNK_BASE64_MAX)
  .refine(
    (value) =>
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
      decodedBase64Bytes(value) >= 1 &&
      decodedBase64Bytes(value) <= MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
    { message: "dataBase64 must be valid non-empty base64 with decoded size <= 24 KiB" },
  )

const prBodyOptionalSchema = z
  .string()
  .max(MOBILE_WORKBENCH_PR_BODY_MAX)
  .refine((value) => utf8ByteLength(value) <= MOBILE_WORKBENCH_PR_BODY_MAX, {
    message: "body exceeds UTF-8 limit of 32 KiB",
  })

const prCommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(MOBILE_WORKBENCH_PR_BODY_MAX)
  .refine((value) => utf8ByteLength(value) <= MOBILE_WORKBENCH_PR_BODY_MAX, {
    message: "body exceeds UTF-8 limit of 32 KiB",
  })

export const mobileWorkspaceWriteFileParams = z.strictObject({
  threadId: key,
  path: pathSchema,
  text: inlineWriteTextSchema,
  expectedMtimeMs: z.number().nonnegative().optional(),
  eol: mobileWorkspaceFileEol.optional(),
})

export const mobileWorkspaceWriteFileResult = z.strictObject({
  path: pathSchema,
  size: z.int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
})

export const mobileWorkspaceWriteStartParams = z.strictObject({
  threadId: key,
  path: pathSchema,
  totalBytes: z.int().nonnegative().max(MOBILE_WORKBENCH_WRITE_MAX_BYTES),
  sha256: sha256Schema,
  expectedMtimeMs: z.number().nonnegative().optional(),
  eol: mobileWorkspaceFileEol.optional(),
})

export const mobileWorkspaceWriteStartResult = z.strictObject({
  sessionId: sessionIdSchema,
  chunkBytes: z.int().min(1).max(MOBILE_WORKBENCH_WRITE_CHUNK_BYTES),
})

export const mobileWorkspaceWriteChunkParams = z.strictObject({
  sessionId: sessionIdSchema,
  offset: z.int().nonnegative().max(MOBILE_WORKBENCH_WRITE_MAX_BYTES),
  dataBase64: writeChunkBase64Schema,
})

export const mobileWorkspaceWriteChunkResult = z.strictObject({
  receivedBytes: z.int().nonnegative().max(MOBILE_WORKBENCH_WRITE_MAX_BYTES),
})

export const mobileWorkspaceWriteCommitParams = z.strictObject({
  sessionId: sessionIdSchema,
})

export const mobileWorkspaceWriteCommitResult = mobileWorkspaceWriteFileResult

export const mobileWorkspaceCreateFileParams = z.strictObject({
  threadId: key,
  path: pathSchema,
  text: inlineWriteTextSchema.optional(),
})

export const mobileWorkspaceCreateFileResult = mobileWorkspaceWriteFileResult

export const mobileWorkspaceRenamePathParams = z.strictObject({
  threadId: key,
  oldPath: pathSchema,
  newPath: pathSchema,
})

export const mobileWorkspaceRenamePathResult = z.strictObject({
  oldPath: pathSchema,
  newPath: pathSchema,
})

export const mobileWorkspaceDeletePathParams = z.strictObject({
  threadId: key,
  path: pathSchema,
  recursive: z.boolean().optional(),
})

export const mobileWorkspaceDeletePathResult = z.strictObject({
  path: pathSchema,
  deleted: z.literal(true),
})

export const mobileWorktreeItem = z.strictObject({
  id: key,
  name: z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX),
  branch: z.string().min(1).nullable(),
  active: z.boolean(),
})

export const mobileWorktreeListParams = z.strictObject({
  threadId: key,
})

export const mobileWorktreeListResult = z.strictObject({
  worktrees: z.array(mobileWorktreeItem),
  mainActive: z.boolean(),
})

export const mobileWorktreeCreateParams = z.strictObject({
  threadId: key,
})

export const mobileWorktreeCreateResult = z.strictObject({
  worktree: mobileWorktreeItem,
})

export const mobileWorktreeSwitchParams = z.strictObject({
  threadId: key,
  worktreeId: key,
})

export const mobileWorktreeSwitchResult = z.strictObject({
  worktree: mobileWorktreeItem,
})

export const mobileWorktreeRemoveParams = z.strictObject({
  threadId: key,
})

export const mobileWorktreeRemoveResult = z.strictObject({
  removed: z.literal(true),
})

export const mobileCheckpointPhase = z.enum(["baseline", "final", "manual"])

export const mobileCheckpointItem = z.strictObject({
  id: key,
  runId: key.nullable(),
  phase: mobileCheckpointPhase,
  label: z.string().max(MOBILE_WORKBENCH_LABEL_MAX).nullable(),
  createdAt: z.string().min(1),
  restorable: z.boolean(),
})

export const mobileCheckpointListParams = z.strictObject({
  threadId: key,
})

export const mobileCheckpointListResult = z.strictObject({
  checkpoints: z.array(mobileCheckpointItem),
})

export const mobileCheckpointCreateParams = z.strictObject({
  threadId: key,
  label: z.string().trim().max(MOBILE_WORKBENCH_LABEL_MAX).optional(),
})

export const mobileCheckpointCreateResult = z.strictObject({
  checkpoint: mobileCheckpointItem,
})

export const mobileCheckpointRestoreParams = z.strictObject({
  threadId: key,
  checkpointId: key,
})

export const mobileCheckpointRestoreResult = z.strictObject({
  checkpointId: key,
  affectedCount: z.int().nonnegative(),
  affectedPaths: z.array(pathSchema).max(MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT),
})

export const mobilePrMergeMethod = z.enum(["merge", "squash", "rebase"])

export const mobilePrCreateParams = z.strictObject({
  threadId: key,
  title: z.string().trim().min(1).max(MOBILE_WORKBENCH_PR_TITLE_MAX),
  body: prBodyOptionalSchema.optional(),
  base: z.string().trim().min(1).max(256).optional(),
  draft: z.boolean().optional(),
})

export const mobilePrCreateResult = mobilePrStatusResult

export const mobilePrCommentParams = z.strictObject({
  threadId: key,
  body: prCommentBodySchema,
})

export const mobilePrCommentResult = z.strictObject({
  ok: z.literal(true),
})

export const mobilePrMergeParams = z.strictObject({
  threadId: key,
  method: mobilePrMergeMethod,
  deleteBranch: z.boolean().optional(),
})

export const mobilePrMergeResult = mobilePrStatusResult

export const mobilePrReadyParams = z.strictObject({
  threadId: key,
})

export const mobilePrReadyResult = mobilePrStatusResult

export const mobilePrCloseParams = z.strictObject({
  threadId: key,
})

export const mobilePrCloseResult = mobilePrStatusResult

export const mobilePrReopenParams = z.strictObject({
  threadId: key,
})

export const mobilePrReopenResult = mobilePrStatusResult

export type MobileWorkspaceWriteFileParams = z.infer<typeof mobileWorkspaceWriteFileParams>
export type MobileWorkspaceWriteFileResult = z.infer<typeof mobileWorkspaceWriteFileResult>
export type MobileWorkspaceWriteStartParams = z.infer<typeof mobileWorkspaceWriteStartParams>
export type MobileWorkspaceWriteStartResult = z.infer<typeof mobileWorkspaceWriteStartResult>
export type MobileWorkspaceWriteChunkParams = z.infer<typeof mobileWorkspaceWriteChunkParams>
export type MobileWorkspaceWriteChunkResult = z.infer<typeof mobileWorkspaceWriteChunkResult>
export type MobileWorkspaceWriteCommitParams = z.infer<typeof mobileWorkspaceWriteCommitParams>
export type MobileWorkspaceWriteCommitResult = z.infer<typeof mobileWorkspaceWriteCommitResult>
export type MobileWorkspaceCreateFileParams = z.infer<typeof mobileWorkspaceCreateFileParams>
export type MobileWorkspaceCreateFileResult = z.infer<typeof mobileWorkspaceCreateFileResult>
export type MobileWorkspaceRenamePathParams = z.infer<typeof mobileWorkspaceRenamePathParams>
export type MobileWorkspaceRenamePathResult = z.infer<typeof mobileWorkspaceRenamePathResult>
export type MobileWorkspaceDeletePathParams = z.infer<typeof mobileWorkspaceDeletePathParams>
export type MobileWorkspaceDeletePathResult = z.infer<typeof mobileWorkspaceDeletePathResult>
export type MobileWorktreeItem = z.infer<typeof mobileWorktreeItem>
export type MobileWorktreeListParams = z.infer<typeof mobileWorktreeListParams>
export type MobileWorktreeListResult = z.infer<typeof mobileWorktreeListResult>
export type MobileWorktreeCreateParams = z.infer<typeof mobileWorktreeCreateParams>
export type MobileWorktreeCreateResult = z.infer<typeof mobileWorktreeCreateResult>
export type MobileWorktreeSwitchParams = z.infer<typeof mobileWorktreeSwitchParams>
export type MobileWorktreeSwitchResult = z.infer<typeof mobileWorktreeSwitchResult>
export type MobileWorktreeRemoveParams = z.infer<typeof mobileWorktreeRemoveParams>
export type MobileWorktreeRemoveResult = z.infer<typeof mobileWorktreeRemoveResult>
export type MobileCheckpointPhase = z.infer<typeof mobileCheckpointPhase>
export type MobileCheckpointItem = z.infer<typeof mobileCheckpointItem>
export type MobileCheckpointListParams = z.infer<typeof mobileCheckpointListParams>
export type MobileCheckpointListResult = z.infer<typeof mobileCheckpointListResult>
export type MobileCheckpointCreateParams = z.infer<typeof mobileCheckpointCreateParams>
export type MobileCheckpointCreateResult = z.infer<typeof mobileCheckpointCreateResult>
export type MobileCheckpointRestoreParams = z.infer<typeof mobileCheckpointRestoreParams>
export type MobileCheckpointRestoreResult = z.infer<typeof mobileCheckpointRestoreResult>
export type MobilePrMergeMethod = z.infer<typeof mobilePrMergeMethod>
export type MobilePrCreateParams = z.infer<typeof mobilePrCreateParams>
export type MobilePrCreateResult = z.infer<typeof mobilePrCreateResult>
export type MobilePrCommentParams = z.infer<typeof mobilePrCommentParams>
export type MobilePrCommentResult = z.infer<typeof mobilePrCommentResult>
export type MobilePrMergeParams = z.infer<typeof mobilePrMergeParams>
export type MobilePrMergeResult = z.infer<typeof mobilePrMergeResult>
export type MobilePrReadyParams = z.infer<typeof mobilePrReadyParams>
export type MobilePrReadyResult = z.infer<typeof mobilePrReadyResult>
export type MobilePrCloseParams = z.infer<typeof mobilePrCloseParams>
export type MobilePrCloseResult = z.infer<typeof mobilePrCloseResult>
export type MobilePrReopenParams = z.infer<typeof mobilePrReopenParams>
export type MobilePrReopenResult = z.infer<typeof mobilePrReopenResult>

export const mobileWorkbenchWriteModels = {
  MobileWorkspaceWriteFileParams: mobileWorkspaceWriteFileParams,
  MobileWorkspaceWriteFileResult: mobileWorkspaceWriteFileResult,
  MobileWorkspaceWriteStartParams: mobileWorkspaceWriteStartParams,
  MobileWorkspaceWriteStartResult: mobileWorkspaceWriteStartResult,
  MobileWorkspaceWriteChunkParams: mobileWorkspaceWriteChunkParams,
  MobileWorkspaceWriteChunkResult: mobileWorkspaceWriteChunkResult,
  MobileWorkspaceWriteCommitParams: mobileWorkspaceWriteCommitParams,
  MobileWorkspaceWriteCommitResult: mobileWorkspaceWriteCommitResult,
  MobileWorkspaceCreateFileParams: mobileWorkspaceCreateFileParams,
  MobileWorkspaceCreateFileResult: mobileWorkspaceCreateFileResult,
  MobileWorkspaceRenamePathParams: mobileWorkspaceRenamePathParams,
  MobileWorkspaceRenamePathResult: mobileWorkspaceRenamePathResult,
  MobileWorkspaceDeletePathParams: mobileWorkspaceDeletePathParams,
  MobileWorkspaceDeletePathResult: mobileWorkspaceDeletePathResult,
  MobileWorktreeItem: mobileWorktreeItem,
  MobileWorktreeListParams: mobileWorktreeListParams,
  MobileWorktreeListResult: mobileWorktreeListResult,
  MobileWorktreeCreateParams: mobileWorktreeCreateParams,
  MobileWorktreeCreateResult: mobileWorktreeCreateResult,
  MobileWorktreeSwitchParams: mobileWorktreeSwitchParams,
  MobileWorktreeSwitchResult: mobileWorktreeSwitchResult,
  MobileWorktreeRemoveParams: mobileWorktreeRemoveParams,
  MobileWorktreeRemoveResult: mobileWorktreeRemoveResult,
  MobileCheckpointPhase: mobileCheckpointPhase,
  MobileCheckpointItem: mobileCheckpointItem,
  MobileCheckpointListParams: mobileCheckpointListParams,
  MobileCheckpointListResult: mobileCheckpointListResult,
  MobileCheckpointCreateParams: mobileCheckpointCreateParams,
  MobileCheckpointCreateResult: mobileCheckpointCreateResult,
  MobileCheckpointRestoreParams: mobileCheckpointRestoreParams,
  MobileCheckpointRestoreResult: mobileCheckpointRestoreResult,
  MobilePrMergeMethod: mobilePrMergeMethod,
  MobilePrCreateParams: mobilePrCreateParams,
  MobilePrCreateResult: mobilePrCreateResult,
  MobilePrCommentParams: mobilePrCommentParams,
  MobilePrCommentResult: mobilePrCommentResult,
  MobilePrMergeParams: mobilePrMergeParams,
  MobilePrMergeResult: mobilePrMergeResult,
  MobilePrReadyParams: mobilePrReadyParams,
  MobilePrReadyResult: mobilePrReadyResult,
  MobilePrCloseParams: mobilePrCloseParams,
  MobilePrCloseResult: mobilePrCloseResult,
  MobilePrReopenParams: mobilePrReopenParams,
  MobilePrReopenResult: mobilePrReopenResult,
}

export function mobileWorkbenchWriteJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileWorkbenchWriteModels)) {
    registry.add(schema, { id })
  }
  return z.toJSONSchema(registry).schemas
}
