/**
 * 输入框图片附件内存存储、类型定义与剪贴板/拖放文件解析工具。
 * 按 draftKey 保存在本次运行内存里，供 composer-attachments 与 composer-memory 共用。
 */
import {
  MAX_MESSAGE_ATTACHMENTS,
  imageAttachmentMimeTypes,
  type ImageAttachmentMimeType,
  type ImageAttachmentRef,
} from "@pigcode/contracts"

export const COMPOSER_IMAGE_ACCEPT = imageAttachmentMimeTypes.join(",")

const MIME_SET = new Set<string>(imageAttachmentMimeTypes)
const EXTENSION_TO_MIME: Readonly<Record<string, ImageAttachmentMimeType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}

export interface ComposerAttachmentUploadInput {
  dataBase64: string
  fileName?: string | undefined
  mimeType?: ImageAttachmentMimeType | undefined
}

export type ComposerImageUploader = (
  input: ComposerAttachmentUploadInput,
) => Promise<ImageAttachmentRef>

export type ComposerImageReader = (
  attachmentId: string,
  variant: "thumb" | "full",
) => Promise<string>

export type ComposerImagePeeker = (
  attachmentId: string,
  variant: "thumb" | "full",
) => string | undefined

export interface ComposerPreviewImage {
  id: string
  fileName: string
  mimeType?: string | undefined
  width?: number | undefined
  height?: number | undefined
  src?: string | undefined
}

export interface ComposerAttachmentItem {
  localId: string
  attachment?: ImageAttachmentRef | undefined
  fileName: string
  mimeType: string
  sizeBytes: number
  previewUrl?: string | undefined
  status: "uploading" | "ready" | "error"
  error?: string | undefined
  retryPayload?:
    | {
        dataBase64: string
        fileName: string
        mimeType: ImageAttachmentMimeType
      }
    | undefined
}

export const EMPTY_ATTACHMENTS: readonly ComposerAttachmentItem[] = []
export const NO_THREAD_ATTACHMENT_KEY = "\u0000no-thread"

const store = new Map<string, readonly ComposerAttachmentItem[]>()
const listeners = new Set<() => void>()

export function subscribeAttachments(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function attachmentsFor(key: string): readonly ComposerAttachmentItem[] {
  return store.get(key) ?? EMPTY_ATTACHMENTS
}

export function setComposerAttachments(
  key: string,
  items: readonly ComposerAttachmentItem[],
): void {
  if (items.length > 0) store.set(key, items)
  else store.delete(key)
  notify()
}

export function updateAttachmentById(
  preferredKey: string,
  localId: string,
  updater: (item: ComposerAttachmentItem) => ComposerAttachmentItem,
): void {
  const candidates = [preferredKey, ...store.keys()].filter(
    (candidate, index, all) => all.indexOf(candidate) === index,
  )
  for (const key of candidates) {
    const list = store.get(key)
    if (!list) continue
    const index = list.findIndex((item) => item.localId === localId)
    if (index === -1) continue
    const next = list.slice()
    next[index] = updater(list[index]!)
    setComposerAttachments(key, next)
    return
  }
}

function itemFromRef(ref: ImageAttachmentRef): ComposerAttachmentItem {
  return {
    localId: `att:${ref.id}`,
    attachment: ref,
    fileName: ref.fileName,
    mimeType: ref.mimeType,
    sizeBytes: ref.sizeBytes,
    status: "ready",
  }
}

/** 预填或撤回恢复时把已提交的附件元数据放回指定草稿；相同 attachment.id 去重，且不超过上限。 */
export function prefillComposerAttachments(key: string, refs: readonly ImageAttachmentRef[]): void {
  if (refs.length === 0) return
  const existing = attachmentsFor(key)
  const existingIds = new Set(
    existing.map((item) => item.attachment?.id).filter((id): id is string => Boolean(id)),
  )
  const additions = refs.filter((ref) => !existingIds.has(ref.id)).map(itemFromRef)
  if (additions.length === 0) return
  const merged = [...existing, ...additions].slice(0, MAX_MESSAGE_ATTACHMENTS)
  setComposerAttachments(key, merged)
}

/** 恢复完整快照（例如发送失败时放回，保留本地 previewUrl）。 */
export function restoreComposerAttachments(
  key: string,
  items: readonly ComposerAttachmentItem[],
): void {
  if (items.length === 0) return
  setComposerAttachments(key, items.slice(0, MAX_MESSAGE_ATTACHMENTS))
}

/** 草稿换归属（新会话草稿建成会话）：搬到新键下；返回是否搬动了图片。 */
export function moveComposerAttachments(from: string, to: string): boolean {
  const moving = attachmentsFor(from)
  if (moving.length === 0 || from === to) return false
  store.delete(from)
  const existing = attachmentsFor(to)
  const merged = [...existing, ...moving].slice(0, MAX_MESSAGE_ATTACHMENTS)
  setComposerAttachments(to, merged)
  return true
}

/** 测试用：清空全部图片附件草稿。 */
export function resetComposerAttachments(): void {
  store.clear()
  notify()
}

/** 按 MIME 或文件扩展名判断是不是支持的位图图片格式。 */
export function resolveSupportedImageMime(file: File): ImageAttachmentMimeType | null {
  const normalized = file.type.trim().toLowerCase()
  if (normalized) {
    return MIME_SET.has(normalized) ? (normalized as ImageAttachmentMimeType) : null
  }
  const dot = file.name.lastIndexOf(".")
  if (dot < 0) return null
  const ext = file.name.slice(dot + 1).toLowerCase()
  return EXTENSION_TO_MIME[ext] ?? null
}

/** 把 File/Blob 读为 base64 字符串（不依赖 URL.createObjectURL，测试与渲染进程零泄漏）。 */
export async function fileToBase64(file: Blob): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ""
    const chunk = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
    }
    return btoa(binary)
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const comma = value.indexOf(",")
      resolve(comma >= 0 ? value.slice(comma + 1) : value)
    }
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"))
    reader.readAsDataURL(file)
  })
}

/** 从剪贴板提取文件（优先 items，兼容只传 files 的环境）；纯文本粘贴时返回空数组。 */
export function extractClipboardImageFiles(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return []
  const files: File[] = []
  const items = clipboardData.items
  if (items && items.length > 0) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (!item || item.kind !== "file") continue
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : null
      if (file) files.push(file)
    }
  }
  if (files.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    for (let index = 0; index < clipboardData.files.length; index += 1) {
      const file = clipboardData.files[index]
      if (file) files.push(file)
    }
  }
  if (files.length === 0) return []
  const hasPlainText =
    typeof clipboardData.getData === "function" && Boolean(clipboardData.getData("text/plain"))
  if (!hasPlainText) return files
  // 同时带有纯文本时，只拦截真正的图片文件，避免误拦普通富文本/代码粘贴。
  return files.filter(
    (file) => file.type.startsWith("image/") || resolveSupportedImageMime(file) !== null,
  )
}

/** 判断拖拽事件是否包含文件。 */
export function hasDraggedFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files && dataTransfer.files.length > 0) return true
  if (dataTransfer.types) {
    for (let index = 0; index < dataTransfer.types.length; index += 1) {
      if (dataTransfer.types[index] === "Files") return true
    }
  }
  if (dataTransfer.items) {
    for (let index = 0; index < dataTransfer.items.length; index += 1) {
      if (dataTransfer.items[index]?.kind === "file") return true
    }
  }
  return false
}

/** 从 drop 事件提取文件列表。 */
export function extractDroppedFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return []
  const files: File[] = []
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let index = 0; index < dataTransfer.files.length; index += 1) {
      const file = dataTransfer.files[index]
      if (file) files.push(file)
    }
    return files
  }
  if (dataTransfer.items) {
    for (let index = 0; index < dataTransfer.items.length; index += 1) {
      const item = dataTransfer.items[index]
      if (!item || item.kind !== "file") continue
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : null
      if (file) files.push(file)
    }
  }
  return files
}

export function createAttachmentLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local_${crypto.randomUUID()}`
  }
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}
