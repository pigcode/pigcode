/**
 * 用户消息：靠右的圆角气泡，支持顶部图片缩略图区（单张保宽高比、多张 2/3 列网格与灯箱放大）、
 * 长消息折叠并向下渐隐。@ 引用使用可点开的带图标标签。
 * 悬停或聚焦时，气泡下方同时显示复制按钮与发送时间。
 */
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { ImageAttachmentRef } from "@pigcode/contracts"
import { AlertCircle, ChevronDown, ChevronUp, Image as ImageIcon, MessagesSquare } from "lucide-react"
import { FileIcon, useLocale } from "@pigcode/ui-primitives"
import { ImageLightbox, type LightboxImage } from "./image-lightbox"
import { splitPath } from "./tool-fields"
import { relativePath, useConversationActions } from "./tools/common"
import { TurnActions } from "./turn-actions"

/** 折叠时的最大高度；内容超过它（容差 1px）才出现展开按钮。 */
const COLLAPSED_HEIGHT = 120

const MENTION = /(^|\s)@([^\s@]+)/g
const TRAILING = /[,.;:!?，。；：！？、)）\]】"'”’]+$/

/** `@path` 里像文件或目录的引用；其余 @ 原样保留。 */
function mentionPath(token: string): { path: string; rest: string } | null {
  const rest = TRAILING.exec(token)?.[0] ?? ""
  const path = rest ? token.slice(0, -rest.length) : token
  if (!path || !(path.includes("/") || /\.[\w-]+$/.test(path))) return null
  return { path, rest }
}

function Mention({ path }: { path: string }) {
  const { onOpenFile, root } = useConversationActions()
  const directory = path.endsWith("/")
  const { name } = splitPath(path)
  const content = (
    <>
      <FileIcon name={name} kind={directory ? "directory" : "file"} />
      <span className="mention-name">{name}</span>
    </>
  )
  const title = relativePath(path, root)
  if (!onOpenFile || directory) {
    return (
      <span className="mention-file" title={title}>
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="mention-file is-link"
      title={title}
      onClick={() => onOpenFile(path)}
    >
      {content}
    </button>
  )
}

/** @ 引用的会话（#81）：带图标的会话标题，能打开时点一下就切过去。 */
function ThreadMention({ threadId, title }: { threadId: string; title: string }) {
  const { onOpenThread } = useConversationActions()
  const content = (
    <>
      <MessagesSquare className="ic ic-xs" aria-hidden="true" />
      <span className="mention-name">{title}</span>
    </>
  )
  if (!onOpenThread) {
    return (
      <span className="mention-file mention-thread" title={title}>
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="mention-file mention-thread is-link"
      title={title}
      onClick={() => onOpenThread(threadId)}
    >
      {content}
    </button>
  )
}

/**
 * 把文本里的 @ 引用换成标签：先找消息记下的会话引用（`@标题`，长标题优先），其余部分再按文件引用处理。
 */
export function renderMentions(
  text: string,
  references: ReadonlyArray<{ threadId: string; title: string }> = [],
): ReactNode[] {
  if (references.length === 0) return renderFileMentions(text)
  const byLength = [...references].sort((a, b) => b.title.length - a.title.length)
  const nodes: ReactNode[] = []
  let rest = text
  for (let segment = 0; ; segment += 1) {
    let found: { index: number; reference: (typeof byLength)[number] } | null = null
    for (const reference of byLength) {
      const index = rest.indexOf(`@${reference.title}`)
      if (index >= 0 && (found === null || index < found.index)) found = { index, reference }
    }
    if (!found) {
      nodes.push(<Fragment key={`t${segment}`}>{renderFileMentions(rest)}</Fragment>)
      return nodes
    }
    const before = rest.slice(0, found.index)
    if (before) nodes.push(<Fragment key={`t${segment}`}>{renderFileMentions(before)}</Fragment>)
    nodes.push(
      <ThreadMention
        key={`m${segment}`}
        threadId={found.reference.threadId}
        title={found.reference.title}
      />,
    )
    rest = rest.slice(found.index + found.reference.title.length + 1)
  }
}

/** 把文本里的 @路径 换成文件名标签。 */
function renderFileMentions(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? ""
    const mention = mentionPath(match[2] ?? "")
    if (!mention) continue
    const start = (match.index ?? 0) + lead.length
    if (start > last) nodes.push(text.slice(last, start))
    nodes.push(<Mention key={start} path={mention.path} />)
    if (mention.rest) nodes.push(mention.rest)
    last = (match.index ?? 0) + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const SINGLE_MAX_W = 280
const SINGLE_MAX_H = 260

/** 根据已知图片宽高算出单张图防抖占位尺寸，竖屏长截图限制在 280×260 内。 */
function singleImageStyle(attachment: ImageAttachmentRef): CSSProperties | undefined {
  if (!attachment.width || !attachment.height) return undefined
  const scale = Math.min(SINGLE_MAX_W / attachment.width, SINGLE_MAX_H / attachment.height, 1)
  return {
    width: `${Math.max(96, Math.round(attachment.width * scale))}px`,
    aspectRatio: `${attachment.width} / ${attachment.height}`,
  }
}

function attachmentGridLayout(count: number): "single" | "grid-2" | "grid-3" {
  if (count <= 1) return "single"
  if (count === 2 || count === 4) return "grid-2"
  return "grid-3"
}

function UserImageTile({
  attachment,
  single,
  readAttachment,
  peekAttachment,
  onOpen,
}: {
  attachment: ImageAttachmentRef
  single: boolean
  readAttachment?: ((attachmentId: string, variant: "thumb" | "full") => Promise<string>) | undefined
  peekAttachment?: ((attachmentId: string, variant: "thumb" | "full") => string | undefined) | undefined
  onOpen: () => void
}) {
  const { t } = useLocale()
  const [url, setUrl] = useState<string | undefined>(() =>
    peekAttachment?.(attachment.id, "thumb"),
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const cached = peekAttachment?.(attachment.id, "thumb")
    if (cached) {
      setUrl(cached)
      setFailed(false)
      return undefined
    }
    if (!readAttachment) return undefined
    let active = true
    setFailed(false)
    void readAttachment(attachment.id, "thumb")
      .then((next) => {
        if (active) setUrl(next)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [attachment.id, readAttachment, peekAttachment])

  const openLabel = t("chat.images.open").replace("{name}", attachment.fileName)
  return (
    <button
      type="button"
      className="msg-user-image"
      style={single ? singleImageStyle(attachment) : undefined}
      aria-label={openLabel}
      title={failed ? t("chat.images.loadFailed") : attachment.fileName}
      onClick={onOpen}
    >
      {url ? (
        <img src={url} alt={attachment.fileName} loading="lazy" />
      ) : (
        <span className="msg-user-image-placeholder" aria-hidden="true">
          {failed ? <AlertCircle className="ic" /> : <ImageIcon className="ic" />}
        </span>
      )}
    </button>
  )
}

/** 渲染一条用户消息。 */
export const UserBubble = memo(function UserBubble({
  text,
  at = null,
  references = [],
  attachments = [],
  readAttachment: explicitRead,
  peekAttachment: explicitPeek,
  onOpenImage,
}: {
  text: string
  at?: string | null
  references?: ReadonlyArray<{ threadId: string; title: string }>
  attachments?: readonly ImageAttachmentRef[]
  readAttachment?: ((attachmentId: string, variant: "thumb" | "full") => Promise<string>) | undefined
  peekAttachment?: ((attachmentId: string, variant: "thumb" | "full") => string | undefined) | undefined
  onOpenImage?: ((attachments: readonly ImageAttachmentRef[], index: number) => void) | undefined
}) {
  const { t } = useLocale()
  const actions = useConversationActions()
  const readAttachment = explicitRead ?? actions.readAttachment
  const peekAttachment = explicitPeek ?? actions.peekAttachment
  const body = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(COLLAPSED_HEIGHT)
  const [expandable, setExpandable] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [localLightboxIndex, setLocalLightboxIndex] = useState<number | null>(null)
  const hasText = text.length > 0
  const hasAttachments = attachments.length > 0

  useEffect(() => setExpanded(false), [text])

  useLayoutEffect(() => {
    const element = body.current
    if (!element || !hasText) {
      setExpandable(false)
      return undefined
    }
    const measure = () => {
      setHeight(element.scrollHeight)
      if (!expanded) setExpandable(element.scrollHeight > COLLAPSED_HEIGHT + 1)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded, hasText])

  const lightboxImages: LightboxImage[] = attachments.map((item) => ({
    id: item.id,
    fileName: item.fileName,
    mimeType: item.mimeType,
    width: item.width,
    height: item.height,
  }))

  const handleOpenImage = (index: number) => {
    if (onOpenImage) {
      onOpenImage(attachments, index)
      return
    }
    if (actions.onOpenLightbox) {
      actions.onOpenLightbox(lightboxImages, index)
      return
    }
    setLocalLightboxIndex(index)
  }

  const label = expanded ? t("chat.message.collapse") : t("chat.message.expand")
  const clamped = hasText && expandable && !expanded
  const layout = attachmentGridLayout(attachments.length)
  return (
    <div className="turn-user">
      <div
        className="msg-user"
        data-clamped={clamped || undefined}
        data-images-only={hasAttachments && !hasText ? "true" : undefined}
      >
        {hasAttachments ? (
          <div
            className="msg-user-images"
            data-layout={layout}
            role="group"
            aria-label={t("chat.images.label")}
          >
            {attachments.map((attachment, index) => (
              <UserImageTile
                key={attachment.id}
                attachment={attachment}
                single={attachments.length === 1}
                readAttachment={readAttachment}
                peekAttachment={peekAttachment}
                onOpen={() => handleOpenImage(index)}
              />
            ))}
          </div>
        ) : null}
        {hasText ? (
          <div
            ref={body}
            className="msg-user-body"
            style={{
              maxHeight: `${expanded ? Math.max(height, COLLAPSED_HEIGHT) : COLLAPSED_HEIGHT}px`,
            }}
          >
            {renderMentions(text, references)}
          </div>
        ) : null}
        {hasText && expandable ? (
          <div className="msg-user-more">
            <button
              type="button"
              className="msg-user-toggle"
              aria-label={label}
              aria-expanded={expanded}
              title={label}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronUp className="ic ic-sm" aria-hidden="true" />
              ) : (
                <ChevronDown className="ic ic-sm" aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
      </div>
      <TurnActions text={text} at={at} kind="user" />
      {localLightboxIndex !== null ? (
        <ImageLightbox
          images={lightboxImages}
          initialIndex={localLightboxIndex}
          loadFull={
            readAttachment ? (image) => readAttachment(image.id, "full") : undefined
          }
          peekUrl={
            peekAttachment ? (image, variant) => peekAttachment(image.id, variant) : undefined
          }
          onClose={() => setLocalLightboxIndex(null)}
        />
      ) : null}
    </div>
  )
})
