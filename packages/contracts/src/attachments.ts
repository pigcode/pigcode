/** 定义图片附件元数据、限制常量、窗口上传/读取 RPC 与缩略图控制通道消息。 */
import { z } from "zod"

export const imageAttachmentMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const

export const imageAttachmentMimeTypeSchema = z.enum(imageAttachmentMimeTypes)
export type ImageAttachmentMimeType = z.infer<typeof imageAttachmentMimeTypeSchema>

export const MAX_MESSAGE_ATTACHMENTS = 6
export const DESKTOP_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MOBILE_MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MOBILE_THUMBNAIL_MAX_BYTES = 40 * 1024
export const ATTACHMENT_STAGING_TTL_MS = 24 * 60 * 60 * 1000

export const attachmentIdSchema = z.string().min(1).max(128)
export const attachmentIdsSchema = z.array(attachmentIdSchema).max(MAX_MESSAGE_ATTACHMENTS)

/** 会话事件、待发消息与时间线里携带的轻量图片附件元数据，不包含本机绝对路径。 */
export const imageAttachmentSchema = z.strictObject({
  id: attachmentIdSchema,
  mimeType: imageAttachmentMimeTypeSchema,
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})
export type ImageAttachmentRef = z.infer<typeof imageAttachmentSchema>

export const attachmentUploadParamsSchema = z.object({
  dataBase64: z.string().min(1),
  fileName: z.string().min(1).max(255).optional(),
  mimeType: imageAttachmentMimeTypeSchema.optional(),
  threadId: z.string().min(1).optional(),
})
export type AttachmentUploadParams = z.infer<typeof attachmentUploadParamsSchema>

export const attachmentUploadResultSchema = z.object({
  attachment: imageAttachmentSchema,
})
export type AttachmentUploadResult = z.infer<typeof attachmentUploadResultSchema>

export const attachmentReadVariantSchema = z.enum(["thumb", "full"])
export type AttachmentReadVariant = z.infer<typeof attachmentReadVariantSchema>

export const attachmentReadParamsSchema = z.object({
  attachmentId: attachmentIdSchema,
  threadId: z.string().min(1).optional(),
  variant: attachmentReadVariantSchema.default("full"),
})
export type AttachmentReadParams = z.infer<typeof attachmentReadParamsSchema>

export const attachmentReadResultSchema = z.object({
  attachment: imageAttachmentSchema,
  mimeType: imageAttachmentMimeTypeSchema,
  dataBase64: z.string(),
})
export type AttachmentReadResult = z.infer<typeof attachmentReadResultSchema>

/** 仅供 Electron main ↔ Host 控制端口使用的图片缩略图生成请求。 */
export const attachmentThumbnailRequestSchema = z.object({
  type: z.literal("attachment.thumbnail"),
  id: z.string().min(1),
  dataBase64: z.string().min(1),
  maxEdge: z.number().int().positive().max(2048).default(360),
  maxBytes: z.number().int().positive().max(1024 * 1024).default(MOBILE_THUMBNAIL_MAX_BYTES),
})

export const attachmentThumbnailResultSchema = z.object({
  type: z.literal("attachment.thumbnail.result"),
  id: z.string().min(1),
  dataBase64: z.string().nullable(),
})
