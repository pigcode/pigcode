/** Host 统一图片附件库：魔数校验、原子落盘、归属隔离、缩略图缓存与过期清理。 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Context } from "cordis"
import {
  ATTACHMENT_STAGING_TTL_MS,
  DESKTOP_MAX_IMAGE_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MOBILE_THUMBNAIL_MAX_BYTES,
  type ImageAttachmentMimeType,
  type ImageAttachmentRef,
} from "@pigcode/contracts"
import type { UserImageAttachment } from "@pigcode/plugin-sdk"
import { AttachmentStore, toAttachmentRef, type AttachmentRecord } from "../storage/attachment-store"
import { writeBufferAtomic, writeBufferAtomicSync } from "./atomic-write"
import { inspectImageBuffer } from "./image-inspect"

export type AttachmentErrorCode =
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_UNSUPPORTED_TYPE"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_FORBIDDEN"
  | "ATTACHMENT_LIMIT_EXCEEDED"
  | "ATTACHMENT_HASH_MISMATCH"

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface SaveStagingInput {
  buffer: Buffer
  fileName?: string
  ownerDeviceKey?: string | null
  maxBytes?: number
  expectedSha256?: string
  declaredMimeType?: ImageAttachmentMimeType
}

export interface ReadAttachmentOptions {
  threadId?: string
  ownerDeviceKey?: string | null
}

export interface ReadAttachmentBytesResult {
  attachment: ImageAttachmentRef
  mimeType: ImageAttachmentMimeType
  buffer: Buffer
}

export type AttachmentThumbnailer = (
  input: Buffer,
  options: { maxEdge: number; maxBytes: number },
) => Promise<Buffer | null>

export interface AttachmentsConfig {
  attachmentsDir?: string
  now?: () => number
  thumbnailer?: AttachmentThumbnailer
}

export interface AttachmentsService {
  readonly dir: string
  setThumbnailer(thumbnailer: AttachmentThumbnailer | undefined): void
  generateThumbnail(
    input: Buffer,
    options?: { maxEdge?: number; maxBytes?: number },
  ): Promise<Buffer | null>
  saveStaging(input: SaveStagingInput): ImageAttachmentRef
  commitForThread(
    attachmentIds: readonly string[],
    threadId: string,
    ownerDeviceKey?: string | null,
  ): UserImageAttachment[]
  resolveForThread(attachmentIds: readonly string[], threadId: string): UserImageAttachment[]
  resolveRefs(attachmentIds: readonly string[], threadId: string): ImageAttachmentRef[]
  getPath(attachmentId: string, threadId?: string): string | undefined
  readBytes(
    attachmentId: string,
    variant: "thumb" | "full",
    options?: ReadAttachmentOptions,
  ): Promise<ReadAttachmentBytesResult>
  deleteForThread(threadId: string): number
  cleanupExpired(now?: Date | number): number
}

declare module "cordis" {
  interface Context {
    attachments: AttachmentsService
  }
}

export const inject = ["storage"]

export interface AttachmentsPlugin {
  (ctx: Context, config?: AttachmentsConfig): void
  inject: string[]
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_THUMB_MAX_EDGE = 360

function sanitizeFileName(raw: string | undefined, ext: string): string {
  if (!raw) return `image.${ext}`
  const segments = raw.split(/[\\/]+/).filter(Boolean)
  const base = (segments.at(-1) ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 255)
  if (!base || base === "." || base === "..") return `image.${ext}`
  return base
}

function safeStoragePath(dir: string, storageName: string): string {
  if (storageName.includes("/") || storageName.includes("\\") || storageName.includes("..")) {
    throw new AttachmentError("ATTACHMENT_NOT_FOUND", "invalid attachment storage name")
  }
  return join(dir, storageName)
}

export const apply: AttachmentsPlugin = (ctx, config = {}) => {
  const dbPath = ctx.storage.db.name
  let ownsTempDir = false
  let dir: string
  if (config.attachmentsDir) {
    dir = config.attachmentsDir
  } else if (dbPath && dbPath !== ":memory:") {
    dir = join(dirname(dbPath), "attachments")
  } else {
    dir = mkdtempSync(join(tmpdir(), "pigcode-attachments-"))
    ownsTempDir = true
  }
  const thumbsDir = join(dir, "thumbs")
  mkdirSync(dir, { recursive: true })
  const store = new AttachmentStore(ctx.storage.db)
  const now = config.now ?? (() => Date.now())
  let thumbnailer = config.thumbnailer

  function filePathOf(record: AttachmentRecord): string {
    return safeStoragePath(dir, record.storageName)
  }

  function thumbPathOf(id: string): string {
    return safeStoragePath(thumbsDir, `${id}.jpg`)
  }

  function toUserAttachment(record: AttachmentRecord): UserImageAttachment {
    return {
      ...toAttachmentRef(record),
      path: filePathOf(record),
    }
  }

  function removeFiles(records: readonly AttachmentRecord[]): void {
    for (const record of records) {
      rmSync(filePathOf(record), { force: true })
      rmSync(thumbPathOf(record.id), { force: true })
    }
  }

  const service: AttachmentsService = {
    dir,
    setThumbnailer(next) {
      thumbnailer = next
    },
    async generateThumbnail(input, options) {
      if (!thumbnailer) return null
      try {
        const generated = await thumbnailer(input, {
          maxEdge: options?.maxEdge ?? DEFAULT_THUMB_MAX_EDGE,
          maxBytes: options?.maxBytes ?? MOBILE_THUMBNAIL_MAX_BYTES,
        })
        return generated && generated.length > 0 ? generated : null
      } catch {
        return null
      }
    },
    saveStaging(input) {
      const { buffer } = input
      const maxBytes = input.maxBytes ?? DESKTOP_MAX_IMAGE_BYTES
      if (buffer.length === 0) {
        throw new AttachmentError("ATTACHMENT_UNSUPPORTED_TYPE", "empty image payload")
      }
      if (buffer.length > maxBytes) {
        throw new AttachmentError(
          "ATTACHMENT_TOO_LARGE",
          `image exceeds maximum size of ${maxBytes} bytes`,
        )
      }
      const sha256 = createHash("sha256").update(buffer).digest("hex")
      if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
        throw new AttachmentError("ATTACHMENT_HASH_MISMATCH", "image sha256 checksum mismatch")
      }
      const inspected = inspectImageBuffer(buffer)
      if (!inspected) {
        throw new AttachmentError(
          "ATTACHMENT_UNSUPPORTED_TYPE",
          "unsupported or malformed image file",
        )
      }
      if (input.declaredMimeType && input.declaredMimeType !== inspected.mimeType) {
        throw new AttachmentError(
          "ATTACHMENT_UNSUPPORTED_TYPE",
          `declared mimeType ${input.declaredMimeType} does not match ${inspected.mimeType}`,
        )
      }
      const id = `att_${randomUUID()}`
      const storageName = `${id}.${inspected.ext}`
      const fileName = sanitizeFileName(input.fileName, inspected.ext)
      const nowMs = now()
      const record: AttachmentRecord = {
        id,
        threadId: null,
        ownerDeviceKey: input.ownerDeviceKey ?? null,
        sha256,
        mimeType: inspected.mimeType,
        fileName,
        storageName,
        sizeBytes: buffer.length,
        width: inspected.width ?? null,
        height: inspected.height ?? null,
        status: "staging",
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ATTACHMENT_STAGING_TTL_MS).toISOString(),
      }
      const target = filePathOf(record)
      writeBufferAtomicSync(target, buffer)
      try {
        store.insert(record)
      } catch (error) {
        rmSync(target, { force: true })
        throw error
      }
      return toAttachmentRef(record)
    },
    commitForThread(attachmentIds, threadId, ownerDeviceKey = null) {
      const uniqueIds = [...new Set(attachmentIds)]
      if (uniqueIds.length === 0) return []
      if (uniqueIds.length > MAX_MESSAGE_ATTACHMENTS) {
        throw new AttachmentError(
          "ATTACHMENT_LIMIT_EXCEEDED",
          `at most ${MAX_MESSAGE_ATTACHMENTS} attachments are allowed per message`,
        )
      }
      const nowIso = new Date(now()).toISOString()
      return ctx.storage.db.transaction(() => {
        const records = new Map(store.getMany(uniqueIds).map((item) => [item.id, item]))
        const toCommit: string[] = []
        const resolved: UserImageAttachment[] = []
        for (const id of uniqueIds) {
          const record = records.get(id)
          if (!record) {
            throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment not found: ${id}`)
          }
          if (record.status === "committed") {
            if (record.threadId !== threadId) {
              throw new AttachmentError(
                "ATTACHMENT_FORBIDDEN",
                `attachment ${id} belongs to another thread`,
              )
            }
          } else {
            if (record.expiresAt && record.expiresAt <= nowIso) {
              throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment expired: ${id}`)
            }
            if ((record.ownerDeviceKey ?? null) !== (ownerDeviceKey ?? null)) {
              throw new AttachmentError(
                "ATTACHMENT_FORBIDDEN",
                `attachment ${id} belongs to another client`,
              )
            }
            toCommit.push(id)
          }
          const path = filePathOf(record)
          if (!existsSync(path)) {
            throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment file missing: ${id}`)
          }
          resolved.push(toUserAttachment(record))
        }
        if (toCommit.length > 0) store.commitStaging(toCommit, threadId)
        return resolved
      })()
    },
    resolveForThread(attachmentIds, threadId) {
      const uniqueIds = [...new Set(attachmentIds)]
      if (uniqueIds.length === 0) return []
      const records = new Map(store.getMany(uniqueIds).map((item) => [item.id, item]))
      return uniqueIds.map((id) => {
        const record = records.get(id)
        if (!record) {
          throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment not found: ${id}`)
        }
        if (record.status !== "committed" || record.threadId !== threadId) {
          throw new AttachmentError(
            "ATTACHMENT_FORBIDDEN",
            `attachment ${id} is not committed to thread ${threadId}`,
          )
        }
        const path = filePathOf(record)
        if (!existsSync(path)) {
          throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment file missing: ${id}`)
        }
        return toUserAttachment(record)
      })
    },
    resolveRefs(attachmentIds, threadId) {
      const uniqueIds = [...new Set(attachmentIds)]
      if (uniqueIds.length === 0) return []
      const records = new Map(store.getMany(uniqueIds).map((item) => [item.id, item]))
      const refs: ImageAttachmentRef[] = []
      for (const id of uniqueIds) {
        const record = records.get(id)
        if (!record) continue
        if (record.status === "committed" && record.threadId !== threadId) continue
        refs.push(toAttachmentRef(record))
      }
      return refs
    },
    getPath(attachmentId, threadId) {
      const record = store.get(attachmentId)
      if (!record) return undefined
      if (threadId !== undefined && record.status === "committed" && record.threadId !== threadId) {
        return undefined
      }
      const path = filePathOf(record)
      return existsSync(path) ? path : undefined
    },
    async readBytes(attachmentId, variant, options = {}) {
      const record = store.get(attachmentId)
      if (!record) {
        throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment not found: ${attachmentId}`)
      }
      if (record.status === "committed") {
        if (options.threadId !== undefined && record.threadId !== options.threadId) {
          throw new AttachmentError(
            "ATTACHMENT_FORBIDDEN",
            `attachment ${attachmentId} belongs to another thread`,
          )
        }
      } else {
        const nowIso = new Date(now()).toISOString()
        if (record.expiresAt && record.expiresAt <= nowIso) {
          throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment expired: ${attachmentId}`)
        }
        if (
          options.ownerDeviceKey !== undefined &&
          (record.ownerDeviceKey ?? null) !== (options.ownerDeviceKey ?? null)
        ) {
          throw new AttachmentError(
            "ATTACHMENT_FORBIDDEN",
            `attachment ${attachmentId} belongs to another client`,
          )
        }
      }
      const originalPath = filePathOf(record)
      let original: Buffer
      try {
        original = await readFile(originalPath)
      } catch {
        throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment file missing: ${attachmentId}`)
      }
      const attachment = toAttachmentRef(record)
      if (variant === "full" || original.length <= MOBILE_THUMBNAIL_MAX_BYTES) {
        return { attachment, mimeType: record.mimeType, buffer: original }
      }
      const thumbPath = thumbPathOf(record.id)
      if (existsSync(thumbPath)) {
        try {
          const cached = await readFile(thumbPath)
          if (cached.length > 0) {
            return { attachment, mimeType: "image/jpeg", buffer: cached }
          }
        } catch {
          // 缓存读失败时重新生成或回退原图。
        }
      }
      if (thumbnailer) {
        try {
          const generated = await thumbnailer(original, {
            maxEdge: DEFAULT_THUMB_MAX_EDGE,
            maxBytes: MOBILE_THUMBNAIL_MAX_BYTES,
          })
          if (generated && generated.length > 0) {
            await writeBufferAtomic(thumbPath, generated)
            return { attachment, mimeType: "image/jpeg", buffer: generated }
          }
        } catch {
          // 缩略图生成失败时退回原图，不影响读取。
        }
      }
      return { attachment, mimeType: record.mimeType, buffer: original }
    },
    deleteForThread(threadId) {
      const records = store.listByThread(threadId)
      const deleted = store.deleteByThread(threadId)
      removeFiles(records)
      return deleted
    },
    cleanupExpired(at) {
      const cutoff =
        at instanceof Date
          ? at.toISOString()
          : new Date(typeof at === "number" ? at : now()).toISOString()
      const expired = store.listExpiredStaging(cutoff)
      if (expired.length === 0) return 0
      const deleted = store.deleteExpiredStaging(cutoff)
      removeFiles(expired)
      return deleted
    },
  }

  service.cleanupExpired()
  const timer = setInterval(() => {
    try {
      service.cleanupExpired()
    } catch {
      // 后台清理不影响主流程。
    }
  }, CLEANUP_INTERVAL_MS)
  timer.unref()

  ctx.provide("attachments", service)
  ctx.effect(() => () => {
    clearInterval(timer)
    if (ownsTempDir) rmSync(dir, { recursive: true, force: true })
  })
}

apply.inject = inject
