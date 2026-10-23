/**
 * 用户消息（参照 ZCode 的 ConversationUserInputBubble）：靠右的浅色气泡，细边框、右上角小圆角，
 * 最宽 576px。超过 120px 高时折叠并向下渐隐，底部一个圆形按钮展开或收起。@ 引用的文件显示成
 * 带图标的文件名，能打开时可以点击。悬停时气泡下方出现复制。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react"
import { FileIcon, copyText, useLocale } from "@pigcode/ui-primitives"
import { splitPath } from "./tool-fields"
import { relativePath, useConversationActions } from "./tools/common"

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

/** 把文本里的 @ 引用换成文件名标签。 */
export function renderMentions(text: string): ReactNode[] {
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

function CopyAction({ text }: { text: string }) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const label = copied ? t("chat.message.copied") : t("chat.message.copy")
  return (
    <button
      type="button"
      className="turn-action"
      aria-label={label}
      title={label}
      onClick={() => void copyText(text).then(() => setCopied(true))}
    >
      {copied ? (
        <Check className="ic ic-sm" aria-hidden="true" />
      ) : (
        <Copy className="ic ic-sm" aria-hidden="true" />
      )}
    </button>
  )
}

/** 渲染一条用户消息。 */
export const UserBubble = memo(function UserBubble({ text }: { text: string }) {
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
          {renderMentions(text)}
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
      <div className="turn-user-actions">
        <CopyAction text={text} />
      </div>
    </div>
  )
})
