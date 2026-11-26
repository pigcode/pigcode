/** 输入框内置轻量图片预览灯箱（调用方未提供自定义灯箱时使用）。 */
import { useEffect } from "react"
import { X } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import type { ComposerPreviewImage } from "./composer-attachment-store"

export function ImageLightbox({
  image,
  onClose,
}: {
  image: ComposerPreviewImage | null
  onClose: () => void
}) {
  const { t } = useLocale()

  useEffect(() => {
    if (!image) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [image, onClose])

  if (!image?.src) return null

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.lightbox.label")}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="image-lightbox-bar">
        <div className="image-lightbox-meta">
          <span className="image-lightbox-name">{image.fileName}</span>
        </div>
        <div className="image-lightbox-controls">
          <button
            type="button"
            className="image-lightbox-btn"
            aria-label={t("chat.lightbox.close")}
            onClick={onClose}
          >
            <X className="ic" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        className="image-lightbox-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <img className="image-lightbox-img" src={image.src} alt={image.fileName} />
      </div>
    </div>
  )
}
