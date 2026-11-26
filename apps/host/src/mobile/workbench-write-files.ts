/** 手机端工作台文件写入与文件系统管理：单帧/分片保存会话、配额清理、新建/重命名/删除。 */
import { createHash, randomUUID } from "node:crypto"
import {
  MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
  MOBILE_WORKBENCH_WRITE_INLINE_MAX,
  mobileWorkspaceCreateFileResult,
  mobileWorkspaceDeletePathResult,
  mobileWorkspaceRenamePathResult,
  mobileWorkspaceWriteChunkResult,
  mobileWorkspaceWriteCommitResult,
  mobileWorkspaceWriteFileResult,
  mobileWorkspaceWriteStartResult,
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
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { requireMobileThread } from "./command-receipts"
import { MobileRequestError } from "./request-error"
import { requireWorkspace } from "./workbench-helpers"
import { mapWorkspaceWriteError, normalizeWritablePath } from "./workbench-write-helpers"

export const MOBILE_WORKBENCH_WRITE_MAX_SESSIONS_PER_DEVICE = 4
export const MOBILE_WORKBENCH_WRITE_MAX_BUFFER_BYTES_PER_DEVICE = 4 * 1024 * 1024
export const MOBILE_WORKBENCH_WRITE_SESSION_IDLE_TTL_MS = 30_000

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true })

export interface MobileWorkbenchWriteOptions {
  maxSessionsPerDevice?: number
  maxBufferBytesPerDevice?: number
  sessionIdleTtlMs?: number
}

interface WriteSessionEntry {
  sessionId: string
  ownerDeviceKey: string
  owner: MobileWorkbenchFileWriter
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

export class MobileWorkbenchFileWriter {
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
    this.sessionIdleTtlMs = options.sessionIdleTtlMs ?? MOBILE_WORKBENCH_WRITE_SESSION_IDLE_TTL_MS
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

  private armSessionTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const registry = registryByContext.get(this.ctx)
      const entry = registry?.sessions.get(sessionId)
      if (registry && entry) disposeWriteSession(registry, entry)
    }, this.sessionIdleTtlMs)
    timer.unref?.()
    return timer
  }

  async writeFile(params: MobileWorkspaceWriteFileParams): Promise<MobileWorkspaceWriteFileResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
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

  writeStart(params: MobileWorkspaceWriteStartParams): MobileWorkspaceWriteStartResult {
    requireMobileThread(this.ctx, params.threadId)
    requireWorkspace(this.ctx)
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

  writeChunk(params: MobileWorkspaceWriteChunkParams): MobileWorkspaceWriteChunkResult {
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

  async writeCommit(
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
    const workspace = requireWorkspace(this.ctx)
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

  async createFile(
    params: MobileWorkspaceCreateFileParams,
  ): Promise<MobileWorkspaceCreateFileResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
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

  async renamePath(
    params: MobileWorkspaceRenamePathParams,
  ): Promise<MobileWorkspaceRenamePathResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
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

  async deletePath(
    params: MobileWorkspaceDeletePathParams,
  ): Promise<MobileWorkspaceDeletePathResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
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
}
