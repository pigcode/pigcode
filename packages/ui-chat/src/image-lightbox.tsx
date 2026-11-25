/**
 * 全屏图片灯箱：半透明暗色背景，支持高清原图按需加载、左右切图、滚轮/按钮缩放与 Esc/点击遮罩关闭。
 */
import { useEffect, useRef, useState, type WheelEvent } from "react"
import { createPortal } from "react-dom"
import { AlertCircle, ChevronLeft, ChevronRight, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react"
import { Spinner, useLocale } from "@pigcode/ui-primitives"

export interface LightboxImage {
  id: string
  fileName: string
  mimeType?: string | undefined
  width?: number | undefined
  height?: number | undefined
  /** 已知的图片 URL（例如输入框草稿本地预览）；缺少时通过 loadFull 按需加载原图。 */
  src?: string | undefined
}

export interface ImageLightboxProps {
  images: readonly LightboxImage[]
  initialIndex: number
  onClose: () => void
  /** 读取原图（full）URL。 */
  loadFull?: ((image: LightboxImage) => Promise<string>) | undefined
  /** 同步读取已缓存的原图或缩略图 URL 作为初始展示/占位。 */
  peekUrl?: ((image: LightboxImage, variant: "thumb" | "full") => string | undefined) | undefined
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

export function ImageLightbox({
  images,
  initialIndex,
  onClose,
  loadFull,
  peekUrl,
}: ImageLightboxProps) {
  const { t } = useLocale()
  const count = images.length
  const safeInitial = count > 0 ? Math.min(Math.max(initialIndex, 0), count - 1) : 0
  const [index, setIndex] = useState(safeInitial)
  const [zoom, setZoom] = useState(1)
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  const current = images[index]

  useEffect(() => {
    setIndex(safeInitial)
  }, [safeInitial, images])

  useEffect(() => {
    setZoom(1)
  }, [index])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!current) return undefined
    if (current.src) {
      setSrc(current.src)
      setLoading(false)
      setFailed(false)
      return undefined
    }
    const cachedFull = peekUrl?.(current, "full")
    if (cachedFull) {
      setSrc(cachedFull)
      setLoading(false)
      setFailed(false)
      return undefined
    }
    const cachedThumb = peekUrl?.(current, "thumb") ?? null
    setSrc(cachedThumb)
    setFailed(false)
    if (!loadFull) {
      setLoading(false)
      return undefined
    }
    setLoading(true)
    let active = true
    void loadFull(current)
      .then((url) => {
        if (!active) return
        setSrc(url)
        setLoading(false)
        setFailed(false)
      })
      .catch(() => {
        if (!active) return
        setLoading(false)
        if (!cachedThumb) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [current, loadFull, peekUrl])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === "ArrowLeft" && count > 1) {
        event.preventDefault()
        setIndex((value) => Math.max(0, value - 1))
        return
      }
      if (event.key === "ArrowRight" && count > 1) {
        event.preventDefault()
        setIndex((value) => Math.min(count - 1, value + 1))
        return
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault()
        setZoom((value) => clampZoom(value + ZOOM_STEP))
        return
      }
      if (event.key === "-") {
        event.preventDefault()
        setZoom((value) => clampZoom(value - ZOOM_STEP))
        return
      }
      if (event.key === "0") {
        event.preventDefault()
        setZoom(1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [count, onClose])

  if (!current) return null

  const canPrev = index > 0
  const canNext = index < count - 1
  const zoomPercent = `${Math.round(zoom * 100)}%`

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
    setZoom((value) => clampZoom(value + delta))
  }

  const overlay = (
    <div
      ref={dialogRef}
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.lightbox.label")}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="image-lightbox-bar">
        <div className="image-lightbox-meta">
          {count > 1 ? (
            <span className="image-lightbox-counter" data-testid="lightbox-counter">
              {index + 1} / {count}
            </span>
          ) : null}
          <span className="image-lightbox-name" title={current.fileName}>
            {current.fileName}
          </span>
        </div>
        <div className="image-lightbox-controls">
          <button
            type="button"
            className="image-lightbox-btn"
            aria-label={t("chat.lightbox.zoomOut")}
            title={t("chat.lightbox.zoomOut")}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}
          >
            <ZoomOut className="ic" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="image-lightbox-btn"
            aria-label={t("chat.lightbox.zoomReset")}
            title={t("chat.lightbox.zoomReset")}
            onClick={() => setZoom(1)}
          >
            {zoom === 1 ? (
              <span>{zoomPercent}</span>
            ) : (
              <>
                <RotateCcw className="ic ic-sm" aria-hidden="true" />
                <span>{zoomPercent}</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="image-lightbox-btn"
            aria-label={t("chat.lightbox.zoomIn")}
            title={t("chat.lightbox.zoomIn")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}
          >
            <ZoomIn className="ic" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="image-lightbox-btn"
            aria-label={t("chat.lightbox.close")}
            title={t("chat.lightbox.close")}
            onClick={onClose}
          >
            <X className="ic" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        className="image-lightbox-stage"
        onWheel={handleWheel}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {count > 1 ? (
          <button
            type="button"
            className="image-lightbox-nav is-prev"
            aria-label={t("chat.lightbox.prev")}
            title={t("chat.lightbox.prev")}
            disabled={!canPrev}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft className="ic" aria-hidden="true" />
          </button>
        ) : null}
        <div
          className="image-lightbox-frame"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose()
          }}
        >
          {failed ? (
            <div className="image-lightbox-error" role="alert">
              <AlertCircle className="ic" aria-hidden="true" />
              <span>{t("chat.images.loadFailed")}</span>
            </div>
          ) : src ? (
            <img
              className="image-lightbox-img"
              src={src}
              alt={current.fileName}
              data-zoomed={zoom > 1 ? "true" : undefined}
              style={{ transform: `scale(${zoom})` }}
              onClick={() => setZoom((value) => (value > 1 ? 1 : 2))}
            />
          ) : (
            <div className="image-lightbox-loading" role="status">
              <Spinner className="ic" aria-hidden="true" />
              <span>{t("chat.images.loading")}</span>
            </div>
          )}
        </div>
        {count > 1 ? (
          <button
            type="button"
            className="image-lightbox-nav is-next"
            aria-label={t("chat.lightbox.next")}
            title={t("chat.lightbox.next")}
            disabled={!canNext}
            onClick={() => setIndex((value) => Math.min(count - 1, value + 1))}
          >
            <ChevronRight className="ic" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {loading && src ? (
        <span className="sr-only" role="status">
          {t("chat.images.loading")}
        </span>
      ) : null}
    </div>
  )

  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body)
}
