/** 工具行共用的小部件：文件名与父目录、打开文件与子 agent 的入口、状态词与计数文案。 */
import { createContext, useContext, type MouseEvent } from "react"
import { FileIcon, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { splitPath } from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import type { ToolRowStatus } from "../tool-row"

/** 失败时显示「执行失败」（悬停看 reason），这一轮结束时没完成的显示「已停止」。 */
export function toolStatusWord(
  t: ReturnType<typeof useLocale>["t"],
  tool: Pick<ToolCall, "status">,
  reason?: string | undefined,
): ToolRowStatus | null {
  if (tool.status === "failed") return { label: t("chat.toolCall.status.failed"), tooltip: reason }
  if (tool.status === "stopped") return { label: t("chat.toolCall.status.stopped") }
  return null
}

/** 时间线里的跳转动作：打开文件、查看改动、打开子 agent 标签；root 是项目目录。 */
export interface ConversationActions {
  root?: string | undefined
  onOpenFile?: ((path: string) => void) | undefined
  onViewDiff?: ((path?: string) => void) | undefined
  onOpenSubagent?: ((id: string) => void) | undefined
  /** 打开用户 @ 引用的另一个会话（#81）。 */
  onOpenThread?: ((threadId: string) => void) | undefined
}

export const ConversationActionsContext = createContext<ConversationActions>({})

/** 读取时间线的跳转动作。 */
export function useConversationActions(): ConversationActions {
  return useContext(ConversationActionsContext)
}

/** 项目内的路径去掉项目目录前缀；项目外的原样返回。 */
export function relativePath(path: string, root: string | undefined): string {
  if (!root) return path
  const prefix = /[\\/]$/.test(root) ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** 文件名；能打开时是可点击的链接样式，点击不会展开所在的工具行。 */
export function FileChip({ path }: { path: string }) {
  const { onOpenFile, root } = useConversationActions()
  const { name } = splitPath(path)
  const title = relativePath(path, root)
  if (!onOpenFile) {
    return (
      <span className="file-chip" title={title}>
        <FileIcon name={name} kind="file" />
        <span className="truncate">{name}</span>
      </span>
    )
  }
  const open = (event: MouseEvent) => {
    event.stopPropagation()
    onOpenFile(path)
  }
  return (
    <button
      type="button"
      className="file-chip is-link"
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={open}
    >
      <FileIcon name={name} kind="file" />
      <span className="truncate">{name}</span>
    </button>
  )
}

/** 文件的父目录（相对项目），灰色、空间不够时先被截断。 */
export function FileParent({ path }: { path: string }) {
  const { root } = useConversationActions()
  const { parent } = splitPath(relativePath(path, root))
  return parent ? <span className="file-parent truncate">{parent}</span> : null
}

/** 用逗号分隔的多个文件名。 */
export function FileChips({ paths }: { paths: readonly string[] }) {
  return (
    <span className="file-chips">
      {paths.map((path, index) => (
        <span key={path} className="file-chips-item">
          {index > 0 ? <span className="file-chips-sep">,</span> : null}
          <FileChip path={path} />
        </span>
      ))}
    </span>
  )
}

/** 带数量的文案：按数量选 `.one` / `.other`，并替换 `{count}`。 */
export function useCount(): (key: string, count: number) => string {
  const { t } = useLocale()
  return (key, count) =>
    t(`${key}.${count === 1 ? "one" : "other"}` as MessageKey).replace("{count}", String(count))
}

/** 输出的前几行，用作失败原因的提示。 */
export function headLines(text: string | undefined, count = 6): string | undefined {
  const lines = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return undefined
  return lines.slice(0, count).join("\n")
}
