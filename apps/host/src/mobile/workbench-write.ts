/** 手机端工作台写操作处理器：单帧/分片保存文件、文件管理、Worktree、检查点与 PR 操作。 */
import { createHash, randomUUID } from "node:crypto"
import { basename, isAbsolute, resolve } from "node:path"
import {
  MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
  MOBILE_WORKBENCH_LABEL_MAX,
  MOBILE_WORKBENCH_PATH_MAX,
  MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
  MOBILE_WORKBENCH_WRITE_INLINE_MAX,
  MOBILE_WORKBENCH_WRITE_MAX_BYTES,
  mobileCheckpointCreateParams,
  mobileCheckpointCreateResult,
  mobileCheckpointListParams,
  mobileCheckpointListResult,
  mobileCheckpointRestoreParams,
  mobileCheckpointRestoreResult,
  mobilePrCloseParams,
  mobilePrCloseResult,
  mobilePrCommentParams,
  mobilePrCommentResult,
  mobilePrCreateParams,
  mobilePrCreateResult,
  mobilePrMergeParams,
  mobilePrMergeResult,
  mobilePrReadyParams,
  mobilePrReadyResult,
  mobilePrReopenParams,
  mobilePrReopenResult,
  mobileWorkbenchWriteMethods as methods,
  mobileWorkspaceCreateFileParams,
  mobileWorkspaceCreateFileResult,
  mobileWorkspaceDeletePathParams,
  mobileWorkspaceDeletePathResult,
  mobileWorkspaceRenamePathParams,
  mobileWorkspaceRenamePathResult,
  mobileWorkspaceWriteChunkParams,
  mobileWorkspaceWriteChunkResult,
  mobileWorkspaceWriteCommitParams,
  mobileWorkspaceWriteCommitResult,
  mobileWorkspaceWriteFileParams,
  mobileWorkspaceWriteFileResult,
  mobileWorkspaceWriteStartParams,
  mobileWorkspaceWriteStartResult,
  mobileWorktreeCreateParams,
  mobileWorktreeCreateResult,
  mobileWorktreeListParams,
  mobileWorktreeListResult,
  mobileWorktreeRemoveParams,
  mobileWorktreeRemoveResult,
  mobileWorktreeSwitchParams,
  mobileWorktreeSwitchResult,
  type MobileCheckpointCreateParams,
  type MobileCheckpointCreateResult,
  type MobileCheckpointItem,
  type MobileCheckpointListParams,
  type MobileCheckpointListResult,
  type MobileCheckpointRestoreParams,
  type MobileCheckpointRestoreResult,
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
  type MobileWorkspaceCreateFileParams,
  type MobileWorkspaceCreateFileResult,
  type MobileWorkspaceDeletePathParams,
  type MobileWorkspaceDeletePathResult,
  type MobileWorkspaceFileEol,
  type MobileWorkspaceRenamePathParams,
  type MobileWorkspaceRenamePathResult,
  type MobileWorkspaceWriteChunkParams,
  type MobileWorkspaceWriteChunkResult,
  type MobileWorkspaceWriteCommitParams,
  type MobileWorkspaceWriteCommitResult,
  type MobileWorkspaceWriteFileParams,
  type MobileWorkspaceWriteFileResult,
  type MobileWorkspaceWriteStartParams,
  type MobileWorkspaceWriteStartResult,
  type MobileWorktreeCreateParams,
  type MobileWorktreeCreateResult,
  type MobileWorktreeListParams,
  type MobileWorktreeListResult,
  type MobileWorktreeRemoveParams,
  type MobileWorktreeRemoveResult,
  type MobileWorktreeSwitchParams,
  type MobileWorktreeSwitchResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { Checkpoint } from "../services/checkpoints"
import { NotAGitRepoError } from "../services/git"
import {
  GhCommandError,
  GhNotAuthenticatedError,
  GhNotAvailableError,
  GitNoRemoteError,
} from "../services/github"
import {
  DirectoryNotEmptyError,
  FileChangedError,
  PathExistsError,
  PathForbiddenError,
} from "../services/workspace"
import { requireMobileThread } from "./command-receipts"
import { sanitizeRelativePath } from "./mentions"
import { mobileParams, MobileRequestError } from "./request-error"

export const MOBILE_WORKBENCH_WRITE_MAX_SESSIONS_PER_DEVICE = 4
export const MOBILE_WORKBENCH_WRITE_MAX_BUFFER_BYTES_PER_DEVICE = 4 * 1024 * 1024
export const MOBILE_WORKBENCH_WRITE_SESSION_IDLE_TTL_MS = 30_000

export const mobileWorkbenchWriteRequests: ReadonlySet<string> = new Set(Object.values(methods))

const windowsDrivePattern = /^[a-zA-Z]:/
const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true })

export interface MobileWorkbenchWriteOptions {
  maxSessionsPerDevice?: number
  maxBufferBytesPerDevice?: number
  sessionIdleTtlMs?: number
}

interface WriteSessionEntry {
  sessionId: string
  ownerDeviceKey: string
  owner: MobileWorkbenchWrite
  threadId: string
  path: string
  totalBytes: number
  sha256: string
  expectedMtimeMs?: number
  eol?: MobileWorkspaceFileEol
  buffer: Buffer
  receivedBytes: number
  timer: ReturnType<typeof setTimeout>
}

interface WriteRegistry {
  sessions: Map<string, WriteSessionEntry>
}

const registryByContext = new WeakMap<Context, WriteRegistry>()

function writeRegistry(ctx: Context): WriteRegistry {
  let registry = registryByContext.get(ctx)
  if (!registry) {
    registry = { sessions: new Map() }
    registryByContext.set(ctx, registry)
  }
  return registry
}

function disposeWriteSession(registry: WriteRegistry, entry: WriteSessionEntry): void {
  clearTimeout(entry.timer)
  registry.sessions.delete(entry.sessionId)
  entry.owner.forgetSession(entry.sessionId)
}

/** 撤销设备配对时，立即释放该设备所有进行中的分片文件写入缓冲。 */
export function cleanupDeviceMobileWorkbenchWrites(ctx: Context, deviceKey: string): void {
  const registry = registryByContext.get(ctx)
  if (!registry) return
  for (const entry of [...registry.sessions.values()]) {
    if (entry.ownerDeviceKey !== deviceKey) continue
    disposeWriteSession(registry, entry)
  }
}

function errorCodeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return (error as { code?: unknown }).code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseWriteFileParams(input: unknown): MobileWorkspaceWriteFileParams {
  const value = input === undefined ? {} : input
  const parsed = mobileWorkspaceWriteFileParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (
    isRecord(value) &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text, "utf8") > MOBILE_WORKBENCH_WRITE_INLINE_MAX &&
    mobileWorkspaceWriteFileParams.safeParse({ ...value, text: "" }).success
  ) {
    throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

function parseCreateFileParams(input: unknown): MobileWorkspaceCreateFileParams {
  const value = input === undefined ? {} : input
  const parsed = mobileWorkspaceCreateFileParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (
    isRecord(value) &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text, "utf8") > MOBILE_WORKBENCH_WRITE_INLINE_MAX &&
    mobileWorkspaceCreateFileParams.safeParse({ ...value, text: "" }).success
  ) {
    throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

function parseWriteStartParams(input: unknown): MobileWorkspaceWriteStartParams {
  const value = input === undefined ? {} : input
  const parsed = mobileWorkspaceWriteStartParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (
    isRecord(value) &&
    typeof value.totalBytes === "number" &&
    Number.isInteger(value.totalBytes) &&
    value.totalBytes > MOBILE_WORKBENCH_WRITE_MAX_BYTES &&
    mobileWorkspaceWriteStartParams.safeParse({ ...value, totalBytes: 1 }).success
  ) {
    throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

/** 校验并规范化可写相对路径；提前拒绝绝对路径、NUL、`..`、根目录与 `.git`。 */
function normalizeWritablePath(raw: string): string {
  if (
    raw.length === 0 ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    windowsDrivePattern.test(raw) ||
    isAbsolute(raw)
  ) {
    throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
  }
  const segments = raw.replaceAll("\\", "/").split("/")
  const clean: string[] = []
  for (const segment of segments) {
    if (segment === ".." || segment.toLowerCase() === ".git") {
      throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
    }
    if (segment === "" || segment === ".") continue
    clean.push(segment)
  }
  if (clean.length === 0) {
    throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
  }
  const normalized = clean.join("/")
  if (normalized.length > MOBILE_WORKBENCH_PATH_MAX) {
    throw new MobileRequestError("INVALID_PARAMS")
  }
  return normalized
}

/** 把底层工作区写入错误映射为规范的 MobileRequestError，不透传宿主机绝对路径。 */
function mapWorkspaceWriteError(error: unknown): never {
  if (error instanceof MobileRequestError) throw error
  if (error instanceof FileChangedError) {
    throw new MobileRequestError("WORKBENCH_FILE_CONFLICT")
  }
  if (error instanceof PathExistsError) {
    throw new MobileRequestError("WORKBENCH_PATH_EXISTS")
  }
  if (error instanceof DirectoryNotEmptyError) {
    throw new MobileRequestError("WORKBENCH_DIR_NOT_EMPTY")
  }
  if (error instanceof PathForbiddenError) {
    throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
  }
  const code = errorCodeOf(error)
  if (code === "EEXIST") throw new MobileRequestError("WORKBENCH_PATH_EXISTS")
  if (code === "ENOTEMPTY") throw new MobileRequestError("WORKBENCH_DIR_NOT_EMPTY")
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ELOOP"
  ) {
    throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith("path escapes project:") ||
      message.startsWith("absolute path not allowed:") ||
      message.startsWith("refusing to write git metadata:") ||
      message.startsWith("cannot modify workspace root:") ||
      message.startsWith("cannot move directory into itself:")
    ) {
      throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
    }
    if (message.startsWith("file too large to save:")) {
      throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
    }
    if (message === "path must not be empty" || message.startsWith("not a file:")) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
  }
  throw error
}

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

export class MobileWorkbenchWrite {
  private readonly ownedSessions = new Set<string>()
  private readonly maxSessionsPerDevice: number
  private readonly maxBufferBytesPerDevice: number
  private readonly sessionIdleTtlMs: number

  constructor(
    private readonly ctx: Context,
    private readonly deviceKey: string,
    private readonly requirePairedDevice: () => void,
    options: MobileWorkbenchWriteOptions = {},
  ) {
    this.maxSessionsPerDevice =
      options.maxSessionsPerDevice ?? MOBILE_WORKBENCH_WRITE_MAX_SESSIONS_PER_DEVICE
    this.maxBufferBytesPerDevice =
      options.maxBufferBytesPerDevice ?? MOBILE_WORKBENCH_WRITE_MAX_BUFFER_BYTES_PER_DEVICE
    this.sessionIdleTtlMs =
      options.sessionIdleTtlMs ?? MOBILE_WORKBENCH_WRITE_SESSION_IDLE_TTL_MS
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.writeFile:
        return this.writeFile(parseWriteFileParams(request.params))
      case methods.writeStart:
        return this.writeStart(parseWriteStartParams(request.params))
      case methods.writeChunk:
        return this.writeChunk(mobileParams(mobileWorkspaceWriteChunkParams, request.params))
      case methods.writeCommit:
        return this.writeCommit(mobileParams(mobileWorkspaceWriteCommitParams, request.params))
      case methods.createFile:
        return this.createFile(parseCreateFileParams(request.params))
      case methods.renamePath:
        return this.renamePath(mobileParams(mobileWorkspaceRenamePathParams, request.params))
      case methods.deletePath:
        return this.deletePath(mobileParams(mobileWorkspaceDeletePathParams, request.params))
      case methods.worktreeList:
        return this.worktreeList(mobileParams(mobileWorktreeListParams, request.params))
      case methods.worktreeCreate:
        return this.worktreeCreate(mobileParams(mobileWorktreeCreateParams, request.params))
      case methods.worktreeSwitch:
        return this.worktreeSwitch(mobileParams(mobileWorktreeSwitchParams, request.params))
      case methods.worktreeRemove:
        return this.worktreeRemove(mobileParams(mobileWorktreeRemoveParams, request.params))
      case methods.checkpointList:
        return this.checkpointList(mobileParams(mobileCheckpointListParams, request.params))
      case methods.checkpointCreate:
        return this.checkpointCreate(mobileParams(mobileCheckpointCreateParams, request.params))
      case methods.checkpointRestore:
        return this.checkpointRestore(mobileParams(mobileCheckpointRestoreParams, request.params))
      case methods.prCreate:
        return this.prCreate(mobileParams(mobilePrCreateParams, request.params))
      case methods.prComment:
        return this.prComment(mobileParams(mobilePrCommentParams, request.params))
      case methods.prMerge:
        return this.prMerge(mobileParams(mobilePrMergeParams, request.params))
      case methods.prReady:
        return this.prReady(mobileParams(mobilePrReadyParams, request.params))
      case methods.prClose:
        return this.prClose(mobileParams(mobilePrCloseParams, request.params))
      case methods.prReopen:
        return this.prReopen(mobileParams(mobilePrReopenParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  /** 连接断开时立即释放本连接仍在进行的分片写入会话与缓冲。 */
  close(): void {
    const registry = registryByContext.get(this.ctx)
    if (registry) {
      for (const sessionId of [...this.ownedSessions]) {
        const entry = registry.sessions.get(sessionId)
        if (entry?.owner === this) {
          clearTimeout(entry.timer)
          registry.sessions.delete(sessionId)
        }
      }
    }
    this.ownedSessions.clear()
  }

  /** 仅供撤销配对或空闲超时清理同步移除本地引用。 */
  forgetSession(sessionId: string): void {
    this.ownedSessions.delete(sessionId)
  }

  private requireWorkspace() {
    const workspace = this.ctx.get("workspace")
    if (!workspace) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return workspace
  }

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

  private requireGithub() {
    const github = this.ctx.get("github")
    if (!github) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return github
  }

  /** 会话（及其共享同一 Worktree 的主会话/子代理会话）有活跃 run 时拒绝切换/删除 worktree 或恢复检查点。 */
  private assertThreadNotBusy(threadId: string): void {
    const agents = this.ctx.get("agents")
    if (!agents) return
    const threads = this.ctx.get("threads")
    const current = threads?.get(threadId)
    const rootThreadId = current?.parentThreadId ?? threadId
    const busyThreads = new Set<string>([
      threadId,
      rootThreadId,
      ...(threads?.children(rootThreadId).map((child) => child.id) ?? []),
    ])
    if (agents.listRuns().some((run) => busyThreads.has(run.threadId))) {
      throw new MobileRequestError("THREAD_BUSY")
    }
  }

  private armSessionTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const registry = registryByContext.get(this.ctx)
      const entry = registry?.sessions.get(sessionId)
      if (registry && entry) disposeWriteSession(registry, entry)
    }, this.sessionIdleTtlMs)
    timer.unref?.()
    return timer
  }

  private async writeFile(
    params: MobileWorkspaceWriteFileParams,
  ): Promise<MobileWorkspaceWriteFileResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
    const path = normalizeWritablePath(params.path)
    if (Buffer.byteLength(params.text, "utf8") > MOBILE_WORKBENCH_WRITE_INLINE_MAX) {
      throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
    }

    let result
    try {
      result = await workspace.writeFile(params.threadId, path, params.text, {
        expectedMtimeMs: params.expectedMtimeMs,
        eol: params.eol,
      })
    } catch (error) {
      mapWorkspaceWriteError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)
    return mobileWorkspaceWriteFileResult.parse(result)
  }

  private writeStart(
    params: MobileWorkspaceWriteStartParams,
  ): MobileWorkspaceWriteStartResult {
    requireMobileThread(this.ctx, params.threadId)
    this.requireWorkspace()
    const path = normalizeWritablePath(params.path)

    const registry = writeRegistry(this.ctx)
    let deviceSessions = 0
    let deviceBytes = 0
    for (const existing of registry.sessions.values()) {
      if (existing.ownerDeviceKey !== this.deviceKey) continue
      deviceSessions += 1
      deviceBytes += existing.totalBytes
    }
    if (
      deviceSessions >= this.maxSessionsPerDevice ||
      deviceBytes + params.totalBytes > this.maxBufferBytesPerDevice
    ) {
      throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
    }

    const sessionId = randomUUID()
    const entry: WriteSessionEntry = {
      sessionId,
      ownerDeviceKey: this.deviceKey,
      owner: this,
      threadId: params.threadId,
      path,
      totalBytes: params.totalBytes,
      sha256: params.sha256,
      ...(params.expectedMtimeMs !== undefined ? { expectedMtimeMs: params.expectedMtimeMs } : {}),
      ...(params.eol !== undefined ? { eol: params.eol } : {}),
      buffer: Buffer.alloc(params.totalBytes),
      receivedBytes: 0,
      timer: this.armSessionTimer(sessionId),
    }
    registry.sessions.set(sessionId, entry)
    this.ownedSessions.add(sessionId)

    return mobileWorkspaceWriteStartResult.parse({
      sessionId,
      chunkBytes: MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
    })
  }

  private writeChunk(
    params: MobileWorkspaceWriteChunkParams,
  ): MobileWorkspaceWriteChunkResult {
    const registry = writeRegistry(this.ctx)
    const entry = registry.sessions.get(params.sessionId)
    if (!entry || entry.ownerDeviceKey !== this.deviceKey) {
      throw new MobileRequestError("WORKBENCH_WRITE_SESSION_NOT_FOUND")
    }

    const bytes = Buffer.from(params.dataBase64, "base64")
    if (bytes.length === 0 || bytes.length > MOBILE_WORKBENCH_WRITE_CHUNK_BYTES) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    if (params.offset !== entry.receivedBytes || params.offset + bytes.length > entry.totalBytes) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    bytes.copy(entry.buffer, params.offset)
    entry.receivedBytes += bytes.length
    clearTimeout(entry.timer)
    entry.timer = this.armSessionTimer(entry.sessionId)

    return mobileWorkspaceWriteChunkResult.parse({
      receivedBytes: entry.receivedBytes,
    })
  }

  private async writeCommit(
    params: MobileWorkspaceWriteCommitParams,
  ): Promise<MobileWorkspaceWriteCommitResult> {
    const registry = writeRegistry(this.ctx)
    const entry = registry.sessions.get(params.sessionId)
    if (!entry || entry.ownerDeviceKey !== this.deviceKey) {
      throw new MobileRequestError("WORKBENCH_WRITE_SESSION_NOT_FOUND")
    }
    // 在任何 await 之前同步原子摘除会话、清除空闲定时器并释放配额，避免并发重复提交竞态。
    disposeWriteSession(registry, entry)

    requireMobileThread(this.ctx, entry.threadId)
    const workspace = this.requireWorkspace()
    if (entry.receivedBytes !== entry.totalBytes) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    const digest = createHash("sha256").update(entry.buffer).digest("hex")
    if (digest !== entry.sha256) {
      throw new MobileRequestError("WORKBENCH_HASH_MISMATCH")
    }
    let text: string
    try {
      text = utf8FatalDecoder.decode(entry.buffer)
    } catch {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    let result
    try {
      result = await workspace.writeFile(entry.threadId, entry.path, text, {
        expectedMtimeMs: entry.expectedMtimeMs,
        eol: entry.eol,
      })
    } catch (error) {
      mapWorkspaceWriteError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, entry.threadId)
    return mobileWorkspaceWriteCommitResult.parse(result)
  }

  private async createFile(
    params: MobileWorkspaceCreateFileParams,
  ): Promise<MobileWorkspaceCreateFileResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
    const path = normalizeWritablePath(params.path)
    const text = params.text ?? ""
    if (Buffer.byteLength(text, "utf8") > MOBILE_WORKBENCH_WRITE_INLINE_MAX) {
      throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
    }

    let result
    try {
      result = await workspace.createFile(params.threadId, path, text)
    } catch (error) {
      mapWorkspaceWriteError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)
    return mobileWorkspaceCreateFileResult.parse(result)
  }

  private async renamePath(
    params: MobileWorkspaceRenamePathParams,
  ): Promise<MobileWorkspaceRenamePathResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
    const oldPath = normalizeWritablePath(params.oldPath)
    const newPath = normalizeWritablePath(params.newPath)

    let result
    try {
      result = await workspace.renamePath(params.threadId, oldPath, newPath)
    } catch (error) {
      mapWorkspaceWriteError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)
    return mobileWorkspaceRenamePathResult.parse(result)
  }

  private async deletePath(
    params: MobileWorkspaceDeletePathParams,
  ): Promise<MobileWorkspaceDeletePathResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
    const path = normalizeWritablePath(params.path)

    let result
    try {
      result = await workspace.deletePath(params.threadId, path, { recursive: params.recursive })
    } catch (error) {
      mapWorkspaceWriteError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)
    return mobileWorkspaceDeletePathResult.parse(result)
  }

  private async worktreeList(
    params: MobileWorktreeListParams,
  ): Promise<MobileWorktreeListResult> {
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

  private async worktreeCreate(
    params: MobileWorktreeCreateParams,
  ): Promise<MobileWorktreeCreateResult> {
    requireMobileThread(this.ctx, params.threadId)
    this.assertThreadNotBusy(params.threadId)
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

  private async worktreeSwitch(
    params: MobileWorktreeSwitchParams,
  ): Promise<MobileWorktreeSwitchResult> {
    requireMobileThread(this.ctx, params.threadId)
    this.assertThreadNotBusy(params.threadId)
    const worktrees = this.requireWorktrees()

    const list = await worktrees.list(params.threadId)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)
    this.assertThreadNotBusy(params.threadId)

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

  private async worktreeRemove(
    params: MobileWorktreeRemoveParams,
  ): Promise<MobileWorktreeRemoveResult> {
    requireMobileThread(this.ctx, params.threadId)
    this.assertThreadNotBusy(params.threadId)
    const worktrees = this.requireWorktrees()
    if (!worktrees.activePath(params.threadId)) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }

    await worktrees.remove(params.threadId)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    return mobileWorktreeRemoveResult.parse({ removed: true })
  }

  private checkpointList(params: MobileCheckpointListParams): MobileCheckpointListResult {
    requireMobileThread(this.ctx, params.threadId)
    const checkpoints = this.requireCheckpoints()
    return mobileCheckpointListResult.parse({
      checkpoints: checkpoints.list(params.threadId).map(toMobileCheckpoint),
    })
  }

  private async checkpointCreate(
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

  private async checkpointRestore(
    params: MobileCheckpointRestoreParams,
  ): Promise<MobileCheckpointRestoreResult> {
    requireMobileThread(this.ctx, params.threadId)
    this.assertThreadNotBusy(params.threadId)
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

  private async prCreate(params: MobilePrCreateParams): Promise<MobilePrCreateResult> {
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

  private async prComment(params: MobilePrCommentParams): Promise<MobilePrCommentResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.requireGithub()
    return this.runPrAction(async () => {
      await github.comment(params.threadId, params.body)
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
      return mobilePrCommentResult.parse({ ok: true })
    })
  }

  private async prMerge(params: MobilePrMergeParams): Promise<MobilePrMergeResult> {
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

  private async prReady(params: MobilePrReadyParams): Promise<MobilePrReadyResult> {
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

  private async prClose(params: MobilePrCloseParams): Promise<MobilePrCloseResult> {
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

  private async prReopen(params: MobilePrReopenParams): Promise<MobilePrReopenResult> {
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
