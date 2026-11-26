/**
 * 输入框图片附件状态管理 Hook 与缩略图预览条。
 * 存储、类型定义与剪贴板/拖放文件解析工具在 composer-attachment-store.ts 中，并在此统一 re-export。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  DESKTOP_MAX_IMAGE_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  type ImageAttachmentMimeType,
  type ImageAttachmentRef,
} from "@pigcode/contracts"
import { AlertCircle, Image as ImageIcon, Info, RotateCw, X } from "lucide-react"
import {
  Spinner,
  hostErrorMessageKey,
  toHostError,
  useLocale,
  type MessageKey,
} from "@pigcode/ui-primitives"
import {
  EMPTY_ATTACHMENTS,
  NO_THREAD_ATTACHMENT_KEY,
  attachmentsFor,
  createAttachmentLocalId,
  fileToBase64,
  resolveSupportedImageMime,
  setComposerAttachments,
  subscribeAttachments,
  updateAttachmentById,
  type ComposerAttachmentItem,
  type ComposerImagePeeker,
  type ComposerImageReader,
  type ComposerImageUploader,
  type ComposerPreviewImage,
} from "./composer-attachment-store"
import { ImageLightbox } from "./image-lightbox"

export {
  COMPOSER_IMAGE_ACCEPT,
  attachmentsFor,
  extractClipboardImageFiles,
  extractDroppedFiles,
  fileToBase64,
  hasDraggedFiles,
  moveComposerAttachments,
  prefillComposerAttachments,
  resetComposerAttachments,
  resolveSupportedImageMime,
  restoreComposerAttachments,
  setComposerAttachments,
  type ComposerAttachmentItem,
  type ComposerAttachmentUploadInput,
  type ComposerImagePeeker,
  type ComposerImageReader,
  type ComposerImageUploader,
  type ComposerPreviewImage,
} from "./composer-attachment-store"

function formatUploadError(error: unknown, t: (key: MessageKey) => string): string {
  const info = toHostError(error)
  const key = hostErrorMessageKey(info.code)
  if (key) return t(key)
  return info.message || t("composer.image.failed")
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
  const key = draftKey ?? NO_THREAD_ATTACHMENT_KEY
  const items = useSyncExternalStore(subscribeAttachments, () => attachmentsFor(key))
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
          firstError ??= tRef
            .current("composer.image.tooLarge")
            .replace("{name}", file.name || "image")
          continue
        }
        if (remaining <= 0) {
          firstError ??= tRef
            .current("composer.image.limitReached")
            .replace("{max}", String(MAX_MESSAGE_ATTACHMENTS))
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

      const pendingItems: ComposerAttachmentItem[] = accepted.map(
        ({ file, mimeType, fileName }) => ({
          localId: createAttachmentLocalId(),
          fileName,
          mimeType,
          sizeBytes: file.size,
          status: "uploading",
        }),
      )
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
    setComposerAttachments(keyRef.current, EMPTY_ATTACHMENTS)
    setError(null)
  }, [])

  const readyAttachments = useMemo(
    () =>
      items
        .filter(
          (item): item is ComposerAttachmentItem & { attachment: ImageAttachmentRef } =>
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
  const [loadedUrl, setLoadedUrl] = useState<string | undefined>(
    () => item.previewUrl ?? (attachmentId ? peekImage?.(attachmentId, "thumb") : undefined),
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
        <div
          className="composer-attachment-overlay is-error"
          title={item.error ?? t("composer.image.failed")}
        >
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
  const closeFallbackPreview = useCallback(() => setFallbackPreview(null), [])

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
      <ImageLightbox image={fallbackPreview} onClose={closeFallbackPreview} />
    </div>
  )
}
