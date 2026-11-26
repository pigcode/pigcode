/** 输入框卡片外框：承载图片拖放高亮遮罩、卡片粘贴兜底与隐藏文件选择器。 */
import { Image as ImageIcon } from "lucide-react"
import {
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { useLocale } from "@pigcode/ui-primitives"
import {
  COMPOSER_IMAGE_ACCEPT,
  extractClipboardImageFiles,
  extractDroppedFiles,
  hasDraggedFiles,
} from "./composer-attachment-store"
import { composerClass } from "./composer-layout"

export interface ComposerDropZoneProps {
  tall: boolean
  expanded: boolean
  meter: boolean
  imageUploadEnabled: boolean
  disabled: boolean
  fileInputRef: RefObject<HTMLInputElement | null>
  onAddFiles: (files: readonly File[] | FileList) => Promise<void>
  children: ReactNode
}

export function ComposerDropZone({
  tall,
  expanded,
  meter,
  imageUploadEnabled,
  disabled,
  fileInputRef,
  onAddFiles,
  children,
}: ComposerDropZoneProps) {
  const { t } = useLocale()
  const [dragging, setDragging] = useState(false)
  const dragDepthRef = useRef(0)

  function handleCardPaste(event: ReactClipboardEvent<HTMLDivElement>): void {
    if (event.defaultPrevented || !imageUploadEnabled || disabled) return
    if (event.target instanceof Element && event.target.closest(".tiptap")) return
    const files = extractClipboardImageFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void onAddFiles(files)
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!imageUploadEnabled || disabled || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!imageUploadEnabled || disabled || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    try {
      event.dataTransfer.dropEffect = "copy"
    } catch {
      // jsdom 等环境里 dataTransfer 可能是只读 mock。
    }
    setDragging(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!imageUploadEnabled || !dragging) return
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    dragDepthRef.current = 0
    setDragging(false)
    if (!imageUploadEnabled || disabled || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const files = extractDroppedFiles(event.dataTransfer)
    if (files.length > 0) void onAddFiles(files)
  }

  return (
    <div
      className={composerClass({ tall, expanded, meter, dragging })}
      onPaste={handleCardPaste}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragging ? (
        <div className="composer-drop-overlay" aria-hidden="true">
          <ImageIcon className="ic" />
          <span>{t("composer.image.dropHint")}</span>
        </div>
      ) : null}
      {imageUploadEnabled ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={COMPOSER_IMAGE_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          data-testid="composer-image-input"
          onChange={(event) => {
            const files = event.target.files
            if (files && files.length > 0) void onAddFiles(files)
            event.target.value = ""
          }}
        />
      ) : null}
      {children}
    </div>
  )
}
