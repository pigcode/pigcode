/**
 * 输入框图片附件状态、草稿记忆与缩略图预览条。
 * 与上下文附件（composer-context.tsx）保持一致：按 draftKey 存在本次运行内存里，
 * 切换会话保留草稿图片，新会话草稿建好后自动搬过去，撤回待发消息时把图片一并放回输入框。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  DESKTOP_MAX_IMAGE_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  imageAttachmentMimeTypes,
  type ImageAttachmentMimeType,
  type ImageAttachmentRef,
} from "@pigcode/contracts"
import { AlertCircle, Image as ImageIcon, Info, RotateCw, X } from "lucide-react"
import { Spinner, hostErrorMessageKey, toHostError, useLocale, type MessageKey } from "@pigcode/ui-primitives"

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

const EMPTY: readonly ComposerAttachmentItem[] = []
const NO_THREAD = "\u0000no-thread"
const store = new Map<string, readonly ComposerAttachmentItem[]>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function attachmentsFor(key: string): readonly ComposerAttachmentItem[] {
  return store.get(key) ?? EMPTY
}

export function setComposerAttachments(
  key: string,
  items: readonly ComposerAttachmentItem[],
): void {
  if (items.length > 0) store.set(key, items)
  else store.delete(key)
  notify()
}

function updateAttachmentById(
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
export function prefillComposerAttachments(
  key: string,
  refs: readonly ImageAttachmentRef[],
): void {
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
export function extractClipboardImageFiles(
  clipboardData: DataTransfer | null | undefined,
): File[] {
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

function formatUploadError(error: unknown, t: (key: MessageKey) => string): string {
  const info = toHostError(error)
  const key = hostErrorMessageKey(info.code)
  if (key) return t(key)
  return info.message || t("composer.image.failed")
}

function createLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local_${crypto.randomUUID()}`
  }
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/** 管理当前草稿的图片附件列表、前置校验、上传与重试。 */
export function useComposerAttachments({
  draftKey,
  disabled,
  onUploadImage,
}: {
  draftKey: string | null
  disabled: boolean
  onUploadImage?: ComposerImageUploader | undefined
}) {
  const { t } = useLocale()
  const key = draftKey ?? NO_THREAD
  const items = useSyncExternalStore(subscribe, () => attachmentsFor(key))
  const [error, setError] = useState<string | null>(null)
  const uploaderRef = useRef(onUploadImage)
  uploaderRef.current = onUploadImage
  const keyRef = useRef(key)
  keyRef.current = key
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    setError(null)
  }, [key])

  const uploadOne = useCallback(
    async (
      targetKey: string,
      localId: string,
      payload: { dataBase64: string; fileName: string; mimeType: ImageAttachmentMimeType },
    ) => {
      const uploader = uploaderRef.current
      if (!uploader) return
      try {
        const attachment = await uploader({
          dataBase64: payload.dataBase64,
          fileName: payload.fileName,
          mimeType: payload.mimeType,
        })
        updateAttachmentById(targetKey, localId, (current) => ({
          ...current,
          attachment,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          status: "ready",
          error: undefined,
          retryPayload: undefined,
        }))
      } catch (cause) {
        const message = formatUploadError(cause, tRef.current)
        updateAttachmentById(targetKey, localId, (current) => ({
          ...current,
          status: "error",
          error: message,
          retryPayload: payload,
        }))
        if (keyRef.current === targetKey) setError(message)
      }
    },
    [],
  )

  const addFiles = useCallback(
    async (incoming: readonly File[] | FileList) => {
      if (disabled || !uploaderRef.current) return
      const files = Array.from(incoming)
      if (files.length === 0) return

      const targetKey = keyRef.current
      const existing = attachmentsFor(targetKey)
      let remaining = MAX_MESSAGE_ATTACHMENTS - existing.length
      let firstError: string | null = null
      const accepted: Array<{
        file: File
        mimeType: ImageAttachmentMimeType
        fileName: string
      }> = []

      for (const file of files) {
        const mimeType = resolveSupportedImageMime(file)
        if (!mimeType || file.size <= 0) {
          firstError ??= tRef.current("composer.image.unsupportedType")
          continue
        }
        if (file.size > DESKTOP_MAX_IMAGE_BYTES) {
          firstError ??= tRef.current("composer.image.tooLarge").replace(
            "{name}",
            file.name || "image",
          )
          continue
        }
        if (remaining <= 0) {
          firstError ??= tRef.current("composer.image.limitReached").replace(
            "{max}",
            String(MAX_MESSAGE_ATTACHMENTS),
          )
          continue
        }
        remaining -= 1
        accepted.push({
          file,
          mimeType,
          fileName: file.name || `image.${mimeType.split("/")[1] ?? "png"}`,
        })
      }

      setError(firstError)
      if (accepted.length === 0) return

      const pendingItems: ComposerAttachmentItem[] = accepted.map(({ file, mimeType, fileName }) => ({
        localId: createLocalId(),
        fileName,
        mimeType,
        sizeBytes: file.size,
        status: "uploading",
      }))
      setComposerAttachments(targetKey, [...attachmentsFor(targetKey), ...pendingItems])

      await Promise.all(
        accepted.map(async ({ file, mimeType, fileName }, index) => {
          const localId = pendingItems[index]!.localId
          try {
            const dataBase64 = await fileToBase64(file)
            const previewUrl = `data:${mimeType};base64,${dataBase64}`
            updateAttachmentById(targetKey, localId, (current) => ({
              ...current,
              previewUrl,
            }))
            await uploadOne(targetKey, localId, { dataBase64, fileName, mimeType })
          } catch (cause) {
            const message = formatUploadError(cause, tRef.current)
            updateAttachmentById(targetKey, localId, (current) => ({
              ...current,
              status: "error",
              error: message,
            }))
            if (keyRef.current === targetKey) setError(message)
          }
        }),
      )
    },
    [disabled, uploadOne],
  )

  const remove = useCallback((localId: string) => {
    const targetKey = keyRef.current
    const next = attachmentsFor(targetKey).filter((item) => item.localId !== localId)
    setComposerAttachments(targetKey, next)
    if (!next.some((item) => item.status === "error")) setError(null)
  }, [])

  const retry = useCallback(
    (localId: string) => {
      const targetKey = keyRef.current
      const item = attachmentsFor(targetKey).find((entry) => entry.localId === localId)
      if (!item?.retryPayload) return
      setError(null)
      updateAttachmentById(targetKey, localId, (current) => ({
        ...current,
        status: "uploading",
        error: undefined,
      }))
      void uploadOne(targetKey, localId, item.retryPayload)
    },
    [uploadOne],
  )

  const clear = useCallback(() => {
    setComposerAttachments(keyRef.current, EMPTY)
    setError(null)
  }, [])

  const readyAttachments = useMemo(
    () =>
      items
        .filter((item): item is ComposerAttachmentItem & { attachment: ImageAttachmentRef } =>
          item.status === "ready" && item.attachment !== undefined,
        )
        .map((item) => item.attachment),
    [items],
  )

  return {
    items,
    readyAttachments,
    uploading: items.some((item) => item.status === "uploading"),
    hasError: items.some((item) => item.status === "error"),
    error,
    dismissError: () => setError(null),
    addFiles,
    remove,
    retry,
    clear,
  }
}

function ComposerAttachmentCard({
  item,
  readImage,
  peekImage,
  onRemove,
  onRetry,
  onPreview,
}: {
  item: ComposerAttachmentItem
  readImage?: ComposerImageReader | undefined
  peekImage?: ComposerImagePeeker | undefined
  onRemove: (localId: string) => void
  onRetry: (localId: string) => void
  onPreview: () => void
}) {
  const { t } = useLocale()
  const attachmentId = item.attachment?.id
  const [loadedUrl, setLoadedUrl] = useState<string | undefined>(() =>
    item.previewUrl ?? (attachmentId ? peekImage?.(attachmentId, "thumb") : undefined),
  )

  useEffect(() => {
    if (item.previewUrl) {
      setLoadedUrl(item.previewUrl)
      return undefined
    }
    if (!attachmentId || !readImage) return undefined
    const cached = peekImage?.(attachmentId, "thumb")
    if (cached) {
      setLoadedUrl(cached)
      return undefined
    }
    let active = true
    void readImage(attachmentId, "thumb")
      .then((url) => {
        if (active) setLoadedUrl(url)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [item.previewUrl, attachmentId, readImage, peekImage])

  const src = item.previewUrl ?? loadedUrl
  const removeLabel = t("composer.image.remove").replace("{name}", item.fileName)
  const previewLabel = t("composer.image.preview").replace("{name}", item.fileName)
  const retryLabel = t("composer.image.retry").replace("{name}", item.fileName)

  return (
    <div className="composer-attachment-card" data-status={item.status}>
      <button
        type="button"
        className="composer-attachment-thumb"
        aria-label={previewLabel}
        title={item.fileName}
        onClick={onPreview}
      >
        {src ? (
          <img src={src} alt={item.fileName} />
        ) : (
          <ImageIcon className="ic" aria-hidden="true" />
        )}
      </button>
      {item.status === "uploading" ? (
        <div
          className="composer-attachment-overlay"
          role="status"
          aria-label={t("composer.image.uploading")}
        >
          <Spinner className="ic" aria-hidden="true" />
        </div>
      ) : null}
      {item.status === "error" ? (
        <div className="composer-attachment-overlay is-error" title={item.error ?? t("composer.image.failed")}>
          {item.retryPayload ? (
            <button
              type="button"
              className="composer-attachment-retry"
              aria-label={retryLabel}
              title={retryLabel}
              onClick={() => onRetry(item.localId)}
            >
              <RotateCw className="ic ic-sm" aria-hidden="true" />
            </button>
          ) : (
            <AlertCircle className="ic" aria-hidden="true" />
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={() => onRemove(item.localId)}
      >
        <X className="ic ic-xs" aria-hidden="true" />
      </button>
    </div>
  )
}

/** 输入框卡片内、文本编辑区正上方的图片缩略图条、上传错误提示与不支持看图轻提示。 */
export function ComposerAttachmentStrip({
  items,
  error,
  supportsImages,
  readImage,
  peekImage,
  onRemove,
  onRetry,
  onDismissError,
  onPreviewImages,
}: {
  items: readonly ComposerAttachmentItem[]
  error: string | null
  supportsImages?: boolean | undefined
  readImage?: ComposerImageReader | undefined
  peekImage?: ComposerImagePeeker | undefined
  onRemove: (localId: string) => void
  onRetry: (localId: string) => void
  onDismissError: () => void
  onPreviewImages?: ((images: readonly ComposerPreviewImage[], index: number) => void) | undefined
}) {
  const { t } = useLocale()
  const [fallbackPreview, setFallbackPreview] = useState<ComposerPreviewImage | null>(null)

  useEffect(() => {
    if (!fallbackPreview) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFallbackPreview(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [fallbackPreview])

  if (items.length === 0 && !error) return null

  const previewList: ComposerPreviewImage[] = items.map((item) => ({
    id: item.attachment?.id ?? item.localId,
    fileName: item.fileName,
    mimeType: item.attachment?.mimeType ?? item.mimeType,
    width: item.attachment?.width,
    height: item.attachment?.height,
    src: item.previewUrl,
  }))

  const handlePreview = (index: number) => {
    const chosen = previewList[index]
    if (!chosen) return
    if (onPreviewImages) {
      onPreviewImages(previewList, index)
      return
    }
    if (chosen.src) setFallbackPreview(chosen)
  }

  return (
    <div className="composer-attachments">
      {items.length > 0 ? (
        <div
          className="composer-attachment-strip"
          role="list"
          aria-label={t("composer.image.stripLabel")}
        >
          {items.map((item, index) => (
            <div key={item.localId} role="listitem">
              <ComposerAttachmentCard
                item={item}
                readImage={readImage}
                peekImage={peekImage}
                onRemove={onRemove}
                onRetry={onRetry}
                onPreview={() => handlePreview(index)}
              />
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="composer-attachment-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="composer-attachment-error-dismiss"
            aria-label={t("composer.image.dismissError")}
            onClick={onDismissError}
          >
            <X className="ic ic-xs" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {items.length > 0 && supportsImages === false ? (
        <p className="composer-attachment-notice" role="status">
          <Info className="ic ic-xs" aria-hidden="true" />
          <span>{t("composer.image.fallbackNotice")}</span>
        </p>
      ) : null}
      {fallbackPreview?.src ? (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.lightbox.label")}
          onClick={(event) => {
            if (event.target === event.currentTarget) setFallbackPreview(null)
          }}
        >
          <div className="image-lightbox-bar">
            <div className="image-lightbox-meta">
              <span className="image-lightbox-name">{fallbackPreview.fileName}</span>
            </div>
            <div className="image-lightbox-controls">
              <button
                type="button"
                className="image-lightbox-btn"
                aria-label={t("chat.lightbox.close")}
                onClick={() => setFallbackPreview(null)}
              >
                <X className="ic" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div
            className="image-lightbox-stage"
            onClick={(event) => {
              if (event.target === event.currentTarget) setFallbackPreview(null)
            }}
          >
            <img
              className="image-lightbox-img"
              src={fallbackPreview.src}
              alt={fallbackPreview.fileName}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
