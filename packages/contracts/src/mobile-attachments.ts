/** 手机端分片上传与读取图片附件的协议定义。 */
import { z } from "zod"
import {
  MOBILE_MAX_IMAGE_BYTES,
  attachmentIdSchema,
  attachmentReadVariantSchema,
  imageAttachmentMimeTypeSchema,
  imageAttachmentSchema,
} from "./attachments"

export const MOBILE_ATTACHMENT_CHUNK_BYTES = 32 * 1024
const MOBILE_ATTACHMENT_CHUNK_BASE64_MAX = Math.ceil(MOBILE_ATTACHMENT_CHUNK_BYTES / 3) * 4

export const mobileAttachmentMethods = {
  uploadStart: "mobile.attachment.uploadStart",
  uploadChunk: "mobile.attachment.uploadChunk",
  uploadCancel: "mobile.attachment.uploadCancel",
  uploadFinish: "mobile.attachment.uploadFinish",
  read: "mobile.attachment.read",
} as const

const uploadIdSchema = z.string().min(1).max(128)
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

export const mobileAttachmentUploadStartParams = z.strictObject({
  uploadId: uploadIdSchema,
  mimeType: imageAttachmentMimeTypeSchema,
  fileName: z.string().min(1).max(255).optional(),
  totalBytes: z.int().min(1).max(MOBILE_MAX_IMAGE_BYTES),
  sha256: sha256HexSchema,
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
})

export const mobileAttachmentUploadStartResult = z.strictObject({
  uploadId: uploadIdSchema,
  chunkBytes: z.int().positive(),
})

export const mobileAttachmentUploadChunkParams = z
  .strictObject({
    uploadId: uploadIdSchema,
    offset: z.int().nonnegative().max(MOBILE_MAX_IMAGE_BYTES),
    dataBase64: z
      .string()
      .min(1)
      .max(MOBILE_ATTACHMENT_CHUNK_BASE64_MAX)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .refine(
    (value) =>
      value.dataBase64.length % 4 === 0 &&
      decodedBase64Bytes(value.dataBase64) > 0 &&
      decodedBase64Bytes(value.dataBase64) <= MOBILE_ATTACHMENT_CHUNK_BYTES,
    { message: "chunk exceeds 32 KiB or has invalid base64 length" },
  )

export const mobileAttachmentUploadChunkResult = z.strictObject({
  uploadId: uploadIdSchema,
  receivedBytes: z.int().nonnegative(),
})

export const mobileAttachmentUploadCancelParams = z.strictObject({
  uploadId: uploadIdSchema,
})

export const mobileAttachmentUploadCancelResult = z.strictObject({
  ok: z.boolean(),
})

export const mobileAttachmentUploadFinishParams = z.strictObject({
  uploadId: uploadIdSchema,
})

export const mobileAttachmentUploadFinishResult = z.strictObject({
  attachment: imageAttachmentSchema,
})

export const mobileAttachmentReadParams = z.strictObject({
  threadId: z.string().min(1).optional(),
  attachmentId: attachmentIdSchema,
  variant: attachmentReadVariantSchema.default("full"),
  offset: z.int().nonnegative().optional(),
  length: z.int().min(1).max(MOBILE_ATTACHMENT_CHUNK_BYTES).optional(),
})

export const mobileAttachmentReadResult = z.strictObject({
  attachment: imageAttachmentSchema,
  mimeType: imageAttachmentMimeTypeSchema,
  dataBase64: z.string(),
  totalBytes: z.int().nonnegative(),
  nextOffset: z.int().positive().optional(),
})

export type MobileAttachmentUploadStartParams = z.infer<typeof mobileAttachmentUploadStartParams>
export type MobileAttachmentUploadStartResult = z.infer<typeof mobileAttachmentUploadStartResult>
export type MobileAttachmentUploadChunkParams = z.infer<typeof mobileAttachmentUploadChunkParams>
export type MobileAttachmentUploadChunkResult = z.infer<typeof mobileAttachmentUploadChunkResult>
export type MobileAttachmentUploadCancelParams = z.infer<typeof mobileAttachmentUploadCancelParams>
export type MobileAttachmentUploadCancelResult = z.infer<typeof mobileAttachmentUploadCancelResult>
export type MobileAttachmentUploadFinishParams = z.infer<typeof mobileAttachmentUploadFinishParams>
export type MobileAttachmentUploadFinishResult = z.infer<typeof mobileAttachmentUploadFinishResult>
export type MobileAttachmentReadParams = z.infer<typeof mobileAttachmentReadParams>
export type MobileAttachmentReadResult = z.infer<typeof mobileAttachmentReadResult>

export const mobileAttachmentModels = {
  ImageAttachment: imageAttachmentSchema,
  MobileAttachmentUploadStartParams: mobileAttachmentUploadStartParams,
  MobileAttachmentUploadStartResult: mobileAttachmentUploadStartResult,
  MobileAttachmentUploadChunkParams: mobileAttachmentUploadChunkParams,
  MobileAttachmentUploadChunkResult: mobileAttachmentUploadChunkResult,
  MobileAttachmentUploadCancelParams: mobileAttachmentUploadCancelParams,
  MobileAttachmentUploadCancelResult: mobileAttachmentUploadCancelResult,
  MobileAttachmentUploadFinishParams: mobileAttachmentUploadFinishParams,
  MobileAttachmentUploadFinishResult: mobileAttachmentUploadFinishResult,
  MobileAttachmentReadParams: mobileAttachmentReadParams,
  MobileAttachmentReadResult: mobileAttachmentReadResult,
}

export function mobileAttachmentJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileAttachmentModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
