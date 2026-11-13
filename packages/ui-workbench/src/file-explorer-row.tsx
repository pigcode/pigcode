/** 资源管理器的一行：缩进参考线、展开箭头、图标、名字（搜索时加粗匹配的字符）与 git 标记。 */
import type { ReactNode } from "react"
import { ChevronRight, RefreshCw } from "lucide-react"
import { FileIcon, ListRow } from "@pigcode/ui-primitives"
import { fuzzyIndices, type GitDecoration, type VisibleRow } from "./file-tree-model"

/** git 改动的字母标记。 */
const GIT_LETTER: Record<GitDecoration, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflict: "!",
}

/** 名字里匹配查询的字符加粗。 */
function highlighted(label: string, query: string): ReactNode {
  const indices = new Set(fuzzyIndices(label, query))
  if (indices.size === 0) return label
  return [...label].map((char, index) =>
    indices.has(index) ? (
      <mark key={index} className="fx-match">
        {char}
      </mark>
    ) : (
      char
    ),
  )
}

/** DOM id 里不能有空格等字符；路径编码后作为行 id。 */
export function rowId(prefix: string, path: string): string {
  return `${prefix}-${encodeURIComponent(path).replace(/%/g, "_")}`
}

/** 一行的属性。 */
export interface ExplorerRowProps {
  row: VisibleRow
  id: string
  top: number
  height: number
  query: string
  active: boolean
  focused: boolean
  loading: boolean
  error: string | undefined
  decoration: GitDecoration | undefined
  /** 目录里面有 git 改动。 */
  changedInside: boolean
  onActivate: () => void
  onOpenTab?: (() => void) | undefined
  onContextMenu?: ((point: { x: number; y: number }) => void) | undefined
}

/** 渲染一行；拖到输入框里就是一段 @路径，与 @ 引用发送出去的文字相同。 */
export function ExplorerRow({
  row,
  id,
  top,
  height,
  query,
  active,
  focused,
  loading,
  error,
  decoration,
  changedInside,
  onActivate,
  onOpenTab,
  onContextMenu,
}: ExplorerRowProps) {
  return (
    <ListRow
      // 整行的提示放在行元素上；ListRow 的 title 是标题这一格
      render={<div title={error ?? row.path} />}
      id={id}
      role="treeitem"
      aria-label={row.label}
      aria-level={row.depth + 1}
      aria-selected={active}
      {...(row.kind === "directory" ? { "aria-expanded": row.expanded } : {})}
      className="fx-row"
      density="compact"
      selected={active}
      data-active={active || undefined}
      data-focused={focused || undefined}
      data-ignored={row.ignored || undefined}
      data-git={decoration}
      draggable
      style={{ top, height, paddingLeft: 6 + row.depth * 12 }}
      onClick={(event) => {
        if (onOpenTab && (event.metaKey || event.ctrlKey)) onOpenTab()
        else onActivate()
      }}
      onContextMenu={(event) => {
        if (!onContextMenu) return
        event.preventDefault()
        onContextMenu({ x: event.clientX, y: event.clientY })
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", `@${row.path} `)
        event.dataTransfer.effectAllowed = "copy"
      }}
      leading={
        <>
          {Array.from({ length: row.depth }, (_unused, level) => (
            <span
              key={level}
              className="fx-guide"
              style={{ left: 13 + level * 12 }}
              aria-hidden="true"
            />
          ))}
          <span className="fx-twisty" data-open={row.expanded || undefined} aria-hidden="true">
            {row.kind === "directory" ? (
              loading ? (
                <RefreshCw className="ic ic-xs spin" />
              ) : (
                <ChevronRight className="ic ic-xs" />
              )
            ) : null}
          </span>
          <FileIcon name={row.entry.name} kind={row.kind} open={row.expanded} />
        </>
      }
      title={highlighted(row.label, query)}
      titleProps={{ className: "fx-label" }}
      meta={
        decoration ? (
          <span className="fx-git" aria-label={decoration}>
            {GIT_LETTER[decoration]}
          </span>
        ) : changedInside ? (
          <span className="fx-git-dot" aria-hidden="true" />
        ) : null
      }
    />
  )
}
