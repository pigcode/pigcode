/** 手机端图片附件分片上传（4 路并发乱序重组）与按需分片读图。 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  MOBILE_MAX_IMAGE_BYTES,
  MOBILE_THUMBNAIL_MAX_BYTES,
  mobileAttachmentMethods as methods,
  mobileAttachmentReadParams,
  mobileAttachmentReadResult,
  mobileAttachmentUploadCancelParams,
  mobileAttachmentUploadCancelResult,
  mobileAttachmentUploadChunkParams,
  mobileAttachmentUploadChunkResult,
  mobileAttachmentUploadFinishParams,
  mobileAttachmentUploadFinishResult,
  mobileAttachmentUploadStartParams,
  mobileAttachmentUploadStartResult,
  type ImageAttachmentMimeType,
  type MobileAttachmentReadParams,
  type MobileAttachmentReadResult,
  type MobileAttachmentUploadCancelParams,
  type MobileAttachmentUploadCancelResult,
  type MobileAttachmentUploadChunkParams,
  type MobileAttachmentUploadChunkResult,
  type MobileAttachmentUploadFinishParams,
  type MobileAttachmentUploadFinishResult,
  type MobileAttachmentUploadStartParams,
  type MobileAttachmentUploadStartResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { AttachmentStore } from "../storage/attachment-store"
import { requireMobileThread } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"

export const MOBILE_MAX_CONCURRENT_UPLOADS = 4
export const MOBILE_MAX_INFLIGHT_UPLOAD_BYTES = 32 * 1024 * 1024

export const mobileAttachmentRequests: ReadonlySet<string> = new Set(Object.values(methods))

interface UploadSession {
  uploadId: string
  ownerDeviceKey: string
  owner: MobileAttachments
  mimeType: ImageAttachmentMimeType
  fileName?: string
  totalBytes: number
  sha256: string
  buffer: Buffer
  /** 已写入的互不重叠半开区间 `[start, end)`，按升序排列并自动合并相邻段。 */
  ranges: Array<[number, number]>
  receivedBytes: number
}

const activeUploadsByContext = new WeakMap<Context, Map<string, UploadSession>>()

function uploadRegistry(ctx: Context): Map<string, UploadSession> {
  let map = activeUploadsByContext.get(ctx)
  if (!map) {
    map = new Map()
    activeUploadsByContext.set(ctx, map)
  }
  return map
}

function parseUploadStartParams(input: unknown): MobileAttachmentUploadStartParams {
  const value = input === undefined ? {} : input
  const parsed = mobileAttachmentUploadStartParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (
      typeof record.totalBytes === "number" &&
      Number.isInteger(record.totalBytes) &&
      record.totalBytes > MOBILE_MAX_IMAGE_BYTES &&
      mobileAttachmentUploadStartParams.safeParse({ ...record, totalBytes: 1 }).success
    ) {
      throw new MobileRequestError("ATTACHMENT_TOO_LARGE")
    }
    if (
      typeof record.mimeType === "string" &&
      mobileAttachmentUploadStartParams.safeParse({ ...record, mimeType: "image/png" }).success
    ) {
      throw new MobileRequestError("ATTACHMENT_UNSUPPORTED_TYPE")
    }
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

function insertDisjointRange(ranges: Array<[number, number]>, start: number, end: number): boolean {
  for (const [existingStart, existingEnd] of ranges) {
    if (start < existingEnd && existingStart < end) return false
  }
  let insertAt = 0
  while (insertAt < ranges.length && ranges[insertAt]![0] < start) insertAt++
  ranges.splice(insertAt, 0, [start, end])

  // 合并与左侧相邻的区间。
  if (insertAt > 0 && ranges[insertAt - 1]![1] === ranges[insertAt]![0]) {
    ranges[insertAt - 1]![1] = ranges[insertAt]![1]
    ranges.splice(insertAt, 1)
    insertAt -= 1
  }
  // 合并与右侧相邻的区间。
  if (insertAt + 1 < ranges.length && ranges[insertAt]![1] === ranges[insertAt + 1]![0]) {
    ranges[insertAt]![1] = ranges[insertAt + 1]![1]
    ranges.splice(insertAt + 1, 1)
  }
  return true
}

function isSafeStorageName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..")
}

/** 撤销设备配对时，中止该设备进行中的分片上传并清理尚未提交的 staging 附件。 */
export function cleanupDeviceMobileAttachments(ctx: Context, deviceKey: string): void {
  const registry = activeUploadsByContext.get(ctx)
  if (registry) {
    for (const [uploadId, session] of [...registry.entries()]) {
      if (session.ownerDeviceKey === deviceKey) {
        registry.delete(uploadId)
        session.owner.forgetUpload(uploadId)
      }
    }
  }

  const attachments = ctx.get("attachments")
  const storage = ctx.get("storage")
  if (!attachments || !storage) return
  const rows = storage.db
    .prepare(
      `SELECT id, storage_name FROM attachments
       WHERE status = 'staging' AND owner_device_key = ?`,
    )
    .all(deviceKey) as Array<{ id: string; storage_name: string }>
  if (rows.length === 0) return
  storage.db
    .prepare(`DELETE FROM attachments WHERE status = 'staging' AND owner_device_key = ?`)
    .run(deviceKey)
  const thumbsDir = join(attachments.dir, "thumbs")
  for (const row of rows) {
    if (isSafeStorageName(row.storage_name)) {
      rmSync(join(attachments.dir, row.storage_name), { force: true })
    }
    if (isSafeStorageName(row.id)) {
      rmSync(join(thumbsDir, `${row.id}.jpg`), { force: true })
    }
  }
}

export interface MobileAttachmentsOptions {
  maxConcurrentUploads?: number
  maxInFlightBytes?: number
}

export class MobileAttachments {
  private readonly ownedUploads = new Set<string>()
  private readonly maxConcurrentUploads: number
  private readonly maxInFlightBytes: number
  private readonly store: AttachmentStore

  constructor(
    private readonly ctx: Context,
    private readonly deviceKey: string,
    private readonly requirePairedDevice: () => void,
    options: MobileAttachmentsOptions = {},
  ) {
    this.maxConcurrentUploads = options.maxConcurrentUploads ?? MOBILE_MAX_CONCURRENT_UPLOADS
    this.maxInFlightBytes = options.maxInFlightBytes ?? MOBILE_MAX_INFLIGHT_UPLOAD_BYTES
    this.store = new AttachmentStore(ctx.storage.db)
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.uploadStart:
        return this.uploadStart(parseUploadStartParams(request.params))
      case methods.uploadChunk:
        return this.uploadChunk(mobileParams(mobileAttachmentUploadChunkParams, request.params))
      case methods.uploadCancel:
        return this.uploadCancel(mobileParams(mobileAttachmentUploadCancelParams, request.params))
      case methods.uploadFinish:
        return this.uploadFinish(mobileParams(mobileAttachmentUploadFinishParams, request.params))
      case methods.read:
        return this.read(mobileParams(mobileAttachmentReadParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  /** 断开连接时释放本连接仍在进行的上传缓冲。 */
  close(): void {
    const registry = activeUploadsByContext.get(this.ctx)
    if (registry) {
      for (const uploadId of this.ownedUploads) {
        const session = registry.get(uploadId)
        if (session?.owner === this) registry.delete(uploadId)
      }
    }
    this.ownedUploads.clear()
  }

  /** 仅供撤销配对清理同步移除本地引用。 */
  forgetUpload(uploadId: string): void {
    this.ownedUploads.delete(uploadId)
  }

  private requireService() {
    const service = this.ctx.get("attachments")
    if (!service) throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    return service
  }

  private requireOwnedSession(uploadId: string): UploadSession {
    const session = uploadRegistry(this.ctx).get(uploadId)
    if (!session) throw new MobileRequestError("ATTACHMENT_NOT_FOUND")
    if (session.ownerDeviceKey !== this.deviceKey) {
      throw new MobileRequestError("ATTACHMENT_FORBIDDEN")
    }
    return session
  }

  private releaseUpload(uploadId: string): void {
    const registry = activeUploadsByContext.get(this.ctx)
    const existing = registry?.get(uploadId)
    if (existing) {
      registry?.delete(uploadId)
      existing.owner.forgetUpload(uploadId)
    }
    this.ownedUploads.delete(uploadId)
  }

  private uploadStart(
    params: MobileAttachmentUploadStartParams,
  ): MobileAttachmentUploadStartResult {
    this.requireService()
    const registry = uploadRegistry(this.ctx)
    if (registry.has(params.uploadId)) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    let deviceUploads = 0
    let deviceBytes = 0
    for (const session of registry.values()) {
      if (session.ownerDeviceKey !== this.deviceKey) continue
      deviceUploads += 1
      deviceBytes += session.totalBytes
    }
    if (
      deviceUploads >= this.maxConcurrentUploads ||
      deviceBytes + params.totalBytes > this.maxInFlightBytes
    ) {
      throw new MobileRequestError("ATTACHMENT_LIMIT_EXCEEDED")
    }

    const session: UploadSession = {
      uploadId: params.uploadId,
      ownerDeviceKey: this.deviceKey,
      owner: this,
      mimeType: params.mimeType,
      ...(params.fileName ? { fileName: params.fileName } : {}),
      totalBytes: params.totalBytes,
      sha256: params.sha256,
      buffer: Buffer.alloc(params.totalBytes),
      ranges: [],
      receivedBytes: 0,
    }
    registry.set(params.uploadId, session)
    this.ownedUploads.add(params.uploadId)

    return mobileAttachmentUploadStartResult.parse({
      uploadId: params.uploadId,
      chunkBytes: MOBILE_ATTACHMENT_CHUNK_BYTES,
    })
  }

  private uploadChunk(
    params: MobileAttachmentUploadChunkParams,
  ): MobileAttachmentUploadChunkResult {
    const session = this.requireOwnedSession(params.uploadId)
    const bytes = Buffer.from(params.dataBase64, "base64")
    if (bytes.length === 0 || bytes.length > MOBILE_ATTACHMENT_CHUNK_BYTES) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    const end = params.offset + bytes.length
    if (params.offset < 0 || end > session.totalBytes) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    if (!insertDisjointRange(session.ranges, params.offset, end)) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    bytes.copy(session.buffer, params.offset)
    session.receivedBytes += bytes.length
    return mobileAttachmentUploadChunkResult.parse({
      uploadId: params.uploadId,
      receivedBytes: session.receivedBytes,
    })
  }

  private uploadCancel(
    params: MobileAttachmentUploadCancelParams,
  ): MobileAttachmentUploadCancelResult {
    const session = uploadRegistry(this.ctx).get(params.uploadId)
    if (session) {
      if (session.ownerDeviceKey !== this.deviceKey) {
        throw new MobileRequestError("ATTACHMENT_FORBIDDEN")
      }
      this.releaseUpload(params.uploadId)
    }
    return mobileAttachmentUploadCancelResult.parse({ ok: true })
  }

  private uploadFinish(
    params: MobileAttachmentUploadFinishParams,
  ): MobileAttachmentUploadFinishResult {
    const service = this.requireService()
    const session = this.requireOwnedSession(params.uploadId)
    try {
      const complete =
        session.ranges.length === 1 &&
        session.ranges[0]![0] === 0 &&
        session.ranges[0]![1] === session.totalBytes &&
        session.receivedBytes === session.totalBytes
      if (!complete) {
        throw new MobileRequestError("INVALID_PARAMS")
      }
      const attachment = service.saveStaging({
        buffer: session.buffer,
        ...(session.fileName ? { fileName: session.fileName } : {}),
        ownerDeviceKey: this.deviceKey,
        maxBytes: MOBILE_MAX_IMAGE_BYTES,
        expectedSha256: session.sha256,
        declaredMimeType: session.mimeType,
      })
      return mobileAttachmentUploadFinishResult.parse({ attachment })
    } finally {
      this.releaseUpload(params.uploadId)
    }
  }

  private async read(params: MobileAttachmentReadParams): Promise<MobileAttachmentReadResult> {
    const service = this.requireService()
    if (params.threadId !== undefined) {
      requireMobileThread(this.ctx, params.threadId)
    }

    const record = this.store.get(params.attachmentId)
    if (!record) throw new MobileRequestError("ATTACHMENT_NOT_FOUND")
    if (record.status === "committed") {
      if (params.threadId !== undefined && record.threadId !== params.threadId) {
        throw new MobileRequestError("ATTACHMENT_FORBIDDEN")
      }
      if (!record.threadId) {
        throw new MobileRequestError("ATTACHMENT_FORBIDDEN")
      }
      // 即使未显式传 threadId，也必须确认所属会话对手机端仍可访问（排除已删项目与子代理会话）。
      requireMobileThread(this.ctx, record.threadId)
    }

    const result = await service.readBytes(params.attachmentId, params.variant, {
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      ownerDeviceKey: this.deviceKey,
    })

    // 异步读取磁盘或生成缩略图后再次确认配对与会话访问权限。
    this.requirePairedDevice()
    if (record.status === "committed" && record.threadId) {
      requireMobileThread(this.ctx, record.threadId)
    }

    const totalBytes = result.buffer.length
    const offset = params.offset ?? 0
    if (totalBytes === 0 ? offset !== 0 : offset >= totalBytes) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    const directThumb =
      params.variant === "thumb" &&
      offset === 0 &&
      params.length === undefined &&
      totalBytes <= MOBILE_THUMBNAIL_MAX_BYTES
    const sliceEnd = directThumb
      ? totalBytes
      : Math.min(offset + (params.length ?? MOBILE_ATTACHMENT_CHUNK_BYTES), totalBytes)
    const slice = result.buffer.subarray(offset, sliceEnd)
    const nextOffset = sliceEnd < totalBytes ? sliceEnd : undefined

    return mobileAttachmentReadResult.parse({
      attachment: result.attachment,
      mimeType: result.mimeType,
      dataBase64: slice.toString("base64"),
      totalBytes,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    })
  }
}
