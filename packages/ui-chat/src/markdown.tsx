/**
 * 助手消息的 Markdown 渲染（参照 ZCode 的 MessageResponse）：只产出 React 元素，不注入 HTML。
 * 代码块带语言、自动换行与复制按钮并按语言高亮；表格、任务列表、嵌套列表、引用、图片与
 * 自动识别的网址都按 ZCode 的排版显示。
 */
import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { CodeBlock } from "./code-block"
import { parseBlocks, type Block, type ListItem } from "./markdown-blocks"

export { parseBlocks } from "./markdown-blocks"

/**
 * 行内标记，按出现位置最靠前者优先：代码、图片、链接、尖括号网址、加粗、删除线、斜体、
 * 裸网址与转义字符。
 */
const INLINE = new RegExp(
  [
    /(`+)([\s\S]+?)\1/.source,
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.source,
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.source,
    /<(https?:\/\/[^\s>]+)>/.source,
    /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/.source,
    /~~([\s\S]+?)~~/.source,
    /\*(?![\s*])([^*\n]+?)\*|(?<![\w])_(?![\s_])([^_\n]+?)_(?![\w])/.source,
    /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"，。；：！？、）》」』])/.source,
    /\\([\\`*_{}[\]()#+\-.!|~<>])/.source,
    / {2,}\n|\\\n/.source,
  ].join("|"),
)

/** 只放行 http、https 与 mailto 链接，其余按普通文本显示。 */
function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href) ? href : null
}

/** 图片只放行网络地址与内嵌的 data 图片。 */
function safeImage(src: string): string | null {
  return /^(https?:|data:image\/)/i.test(src) ? src : null
}

/** 渲染行内 Markdown。 */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let key = 0
  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (!match) {
      nodes.push(rest)
      break
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index))
    const id = `${keyPrefix}-${key}`
    key += 1
    nodes.push(inlineNode(match, id))
    rest = rest.slice(match.index + match[0].length)
  }
  return nodes
}

function inlineNode(match: RegExpExecArray, id: string): ReactNode {
  const [whole, , code, alt, src, label, href, angle, strong, strongAlt, strike, em, emAlt] = match
  const bare = match[13]
  const escaped = match[14]
  if (code !== undefined) return <code key={id}>{code.trim()}</code>
  if (src !== undefined) {
    const safe = safeImage(src)
    return safe ? (
      <span key={id} className="md-image">
        <img src={safe} alt={alt ?? ""} loading="lazy" />
      </span>
    ) : (
      whole
    )
  }
  if (label !== undefined && href !== undefined) {
    const safe = safeHref(href)
    return safe ? (
      <a key={id} href={safe} target="_blank" rel="noopener noreferrer">
        {renderInline(label, id)}
      </a>
    ) : (
      renderInline(label, id)
    )
  }
  const url = angle ?? bare
  if (url !== undefined) {
    return (
      <a key={id} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    )
  }
  if (strong !== undefined || strongAlt !== undefined) {
    return <strong key={id}>{renderInline(strong ?? strongAlt ?? "", id)}</strong>
  }
  if (strike !== undefined) return <del key={id}>{renderInline(strike, id)}</del>
  if (em !== undefined || emAlt !== undefined) {
    return <em key={id}>{renderInline(em ?? emAlt ?? "", id)}</em>
  }
  if (escaped !== undefined) return escaped
  return <br key={id} />
}

const HEADING_TAGS: Record<1 | 2 | 3 | 4 | 5 | 6, "h3" | "h4" | "h5" | "h6"> = {
  1: "h3",
  2: "h4",
  3: "h5",
  4: "h6",
  5: "h6",
  6: "h6",
}

function ListItemView({ item, id, streaming }: { item: ListItem; id: string; streaming: boolean }) {
  const only = item.blocks.length === 1 ? item.blocks[0] : undefined
  const content =
    only?.kind === "paragraph"
      ? renderInline(only.text, id)
      : item.blocks.length === 0
        ? null
        : renderBlocks(item.blocks, id, streaming)
  if (item.task === null) return <li>{content}</li>
  return (
    <li className="md-task">
      <span
        className="md-check"
        role="checkbox"
        aria-checked={item.task}
        aria-readonly="true"
        data-checked={item.task || undefined}
      >
        {item.task ? <Check className="ic" aria-hidden="true" /> : null}
      </span>
      <span>{content}</span>
    </li>
  )
}

function BlockView({ block, id, streaming }: { block: Block; id: string; streaming: boolean }) {
  switch (block.kind) {
    case "heading": {
      const Tag = HEADING_TAGS[block.level]
      return <Tag className={`md-h md-h${block.level}`}>{renderInline(block.text, id)}</Tag>
    }
    case "code":
      return (
        <CodeBlock code={block.text} language={block.lang} streaming={streaming && !block.closed} />
      )
    case "list": {
      const items = block.items.map((item, index) => (
        <ListItemView key={index} item={item} id={`${id}-${index}`} streaming={streaming} />
      ))
      return block.ordered ? (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      )
    }
    case "quote":
      return <blockquote>{renderBlocks(block.blocks, id, streaming)}</blockquote>
    case "table":
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th key={column} data-align={block.align[column] ?? undefined}>
                    {renderInline(cell, `${id}-h${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} data-align={block.align[column] ?? undefined}>
                      {renderInline(cell, `${id}-${rowIndex}-${column}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "rule":
      return <hr />
    default:
      return <p>{renderInline(block.text, id)}</p>
  }
}

function renderBlocks(blocks: readonly Block[], prefix: string, streaming: boolean): ReactNode[] {
  return blocks.map((block, index) => (
    <BlockView
      key={`${prefix}-${index}`}
      block={block}
      id={`${prefix}-${index}`}
      streaming={streaming}
    />
  ))
}

/** 渲染一段 Markdown 文本；streaming 时未闭合的代码块先不高亮。 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <>{renderBlocks(parseBlocks(text), "b", streaming)}</>
}
