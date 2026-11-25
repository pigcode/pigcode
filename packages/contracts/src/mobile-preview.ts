/** 手机端加密本机预览隧道（`preview.tunnel`）的协议定义与桌面控制命令。 */
import { z } from "zod"

export const MOBILE_PREVIEW_INLINE_BODY_MAX = 24 * 1024
export const MOBILE_PREVIEW_CHUNK_BYTES = 32 * 1024
export const MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES = 32 * 1024
export const MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024
export const MOBILE_PREVIEW_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const

export const MOBILE_PREVIEW_URL_MAX = 4096
export const MOBILE_PREVIEW_REQUEST_ID_MAX = 128
export const MOBILE_PREVIEW_STREAM_ID_MAX = 128
export const MOBILE_PREVIEW_MAX_HEADERS = 64
export const MOBILE_PREVIEW_HEADER_NAME_MAX = 256
export const MOBILE_PREVIEW_HEADER_VALUE_MAX = 8192
export const MOBILE_PREVIEW_MAX_DESKTOP_URLS = 64

const MOBILE_PREVIEW_MAX_REQUEST_BODY_BASE64 =
  Math.ceil(MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES / 3) * 4

export const mobilePreviewMethods = {
  status: "mobile.preview.status",
  fetch: "mobile.preview.fetch",
  readBody: "mobile.preview.readBody",
  closeBody: "mobile.preview.closeBody",
} as const

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

const requestBodyBase64Schema = z
  .string()
  .max(MOBILE_PREVIEW_MAX_REQUEST_BODY_BASE64)
  .refine(
    (value) =>
      value === "" ||
      (value.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
        decodedBase64Bytes(value) <= MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES),
    { message: "bodyBase64 must be valid base64 with decoded size <= 32 KiB" },
  )

export const mobilePreviewMethodSchema = z.enum(MOBILE_PREVIEW_ALLOWED_METHODS)

export const mobilePreviewHeaderSchema = z.strictObject({
  name: z.string().min(1).max(MOBILE_PREVIEW_HEADER_NAME_MAX),
  value: z.string().max(MOBILE_PREVIEW_HEADER_VALUE_MAX),
})

export const mobilePreviewUrlSchema = z.string().min(1).max(MOBILE_PREVIEW_URL_MAX)

export const mobilePreviewStatusParams = z.strictObject({
  threadId: z.string().min(1).optional(),
})

export const mobilePreviewStatusResult = z.strictObject({
  enabled: z.boolean(),
  desktopUrls: z.array(mobilePreviewUrlSchema).max(MOBILE_PREVIEW_MAX_DESKTOP_URLS),
})

export const mobilePreviewFetchParams = z.strictObject({
  requestId: z.string().min(1).max(MOBILE_PREVIEW_REQUEST_ID_MAX),
  url: mobilePreviewUrlSchema,
  method: mobilePreviewMethodSchema,
  headers: z
    .record(
      z.string().min(1).max(MOBILE_PREVIEW_HEADER_NAME_MAX),
      z.string().max(MOBILE_PREVIEW_HEADER_VALUE_MAX),
    )
    .refine((record) => Object.keys(record).length <= MOBILE_PREVIEW_MAX_HEADERS, {
      message: "headers count exceeds 64",
    })
    .optional(),
  bodyBase64: requestBodyBase64Schema.optional(),
})

export const mobilePreviewFetchResult = z.strictObject({
  status: z.int().min(100).max(599),
  statusText: z.string().max(256),
  headers: z.array(mobilePreviewHeaderSchema),
  bodyBase64: z.string().optional(),
  bodyStreamId: z.string().min(1).max(MOBILE_PREVIEW_STREAM_ID_MAX).optional(),
  totalBytes: z.int().nonnegative(),
  hasMore: z.boolean(),
})

export const mobilePreviewReadBodyParams = z.strictObject({
  bodyStreamId: z.string().min(1).max(MOBILE_PREVIEW_STREAM_ID_MAX),
  offset: z.int().nonnegative(),
  length: z.int().min(1).max(MOBILE_PREVIEW_CHUNK_BYTES).optional(),
})

export const mobilePreviewReadBodyResult = z.strictObject({
  bodyStreamId: z.string().min(1).max(MOBILE_PREVIEW_STREAM_ID_MAX),
  dataBase64: z.string(),
  totalBytes: z.int().nonnegative(),
  nextOffset: z.int().nonnegative().optional(),
})

export const mobilePreviewCloseBodyParams = z.strictObject({
  bodyStreamId: z.string().min(1).max(MOBILE_PREVIEW_STREAM_ID_MAX),
})

export const mobilePreviewCloseBodyResult = z.strictObject({
  ok: z.literal(true),
})

/** 桌面设置页读写手机本机预览开关的 RPC 契约。 */
export const mobilePreviewGetSettingsParams = z.object({})
export const mobilePreviewSetEnabledParams = z.object({
  enabled: z.boolean(),
})
export const mobilePreviewSettingsSchema = mobilePreviewStatusResult

/** Electron main 经 controlPort 通知 Host 桌面当前打开的本机预览窗口 URL 列表。 */
export const desktopPreviewUrlsMessageSchema = z.strictObject({
  type: z.literal("desktop.previewUrls"),
  urls: z.array(mobilePreviewUrlSchema).max(MOBILE_PREVIEW_MAX_DESKTOP_URLS),
})

export type MobilePreviewMethod = z.infer<typeof mobilePreviewMethodSchema>
export type MobilePreviewHeader = z.infer<typeof mobilePreviewHeaderSchema>
export type MobilePreviewStatusParams = z.infer<typeof mobilePreviewStatusParams>
export type MobilePreviewStatusResult = z.infer<typeof mobilePreviewStatusResult>
export type MobilePreviewFetchParams = z.infer<typeof mobilePreviewFetchParams>
export type MobilePreviewFetchResult = z.infer<typeof mobilePreviewFetchResult>
export type MobilePreviewReadBodyParams = z.infer<typeof mobilePreviewReadBodyParams>
export type MobilePreviewReadBodyResult = z.infer<typeof mobilePreviewReadBodyResult>
export type MobilePreviewCloseBodyParams = z.infer<typeof mobilePreviewCloseBodyParams>
export type MobilePreviewCloseBodyResult = z.infer<typeof mobilePreviewCloseBodyResult>
export type MobilePreviewSettings = z.infer<typeof mobilePreviewSettingsSchema>
export type DesktopPreviewUrlsMessage = z.infer<typeof desktopPreviewUrlsMessageSchema>

export const mobilePreviewModels = {
  MobilePreviewMethod: mobilePreviewMethodSchema,
  MobilePreviewHeader: mobilePreviewHeaderSchema,
  MobilePreviewStatusParams: mobilePreviewStatusParams,
  MobilePreviewStatusResult: mobilePreviewStatusResult,
  MobilePreviewFetchParams: mobilePreviewFetchParams,
  MobilePreviewFetchResult: mobilePreviewFetchResult,
  MobilePreviewReadBodyParams: mobilePreviewReadBodyParams,
  MobilePreviewReadBodyResult: mobilePreviewReadBodyResult,
  MobilePreviewCloseBodyParams: mobilePreviewCloseBodyParams,
  MobilePreviewCloseBodyResult: mobilePreviewCloseBodyResult,
  MobilePreviewSettings: mobilePreviewSettingsSchema,
  DesktopPreviewUrlsMessage: desktopPreviewUrlsMessageSchema,
}

export function mobilePreviewJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobilePreviewModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
