/**
 * 用户消息：靠右的圆角气泡，长消息折叠并向下渐隐。@ 引用使用可点开的带图标标签。
 * 气泡下方显示发送时间，并在悬停或聚焦时显示复制按钮。
 */
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, MessagesSquare } from "lucide-react"
import { FileIcon, useLocale } from "@pigcode/ui-primitives"
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

/** 渲染一条用户消息。 */
export const UserBubble = memo(function UserBubble({
  text,
  at = null,
  references = [],
}: {
  text: string
  at?: string | null
  references?: ReadonlyArray<{ threadId: string; title: string }>
}) {
  const { t } = useLocale()
  const body = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(COLLAPSED_HEIGHT)
  const [expandable, setExpandable] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => setExpanded(false), [text])

  useLayoutEffect(() => {
    const element = body.current
    if (!element) return undefined
    const measure = () => {
      setHeight(element.scrollHeight)
      if (!expanded) setExpandable(element.scrollHeight > COLLAPSED_HEIGHT + 1)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])

  const label = expanded ? t("chat.message.collapse") : t("chat.message.expand")
  const clamped = expandable && !expanded
  return (
    <div className="turn-user">
      <div className="msg-user" data-clamped={clamped || undefined}>
        <div
          ref={body}
          className="msg-user-body"
          style={{
            maxHeight: `${expanded ? Math.max(height, COLLAPSED_HEIGHT) : COLLAPSED_HEIGHT}px`,
          }}
        >
          {renderMentions(text, references)}
        </div>
        {expandable ? (
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
    </div>
  )
})
