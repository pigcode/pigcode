/**
 * 连续查阅的合并行（参照 ZCode 的 explore）：结束后「查阅 · 3 文件, 2 搜索, 1 次网页抓取」，
 * 运行中显示最新一项正在做什么；展开后逐条列出。
 */
import { memo, type ReactNode } from "react"
import { Search } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { fetchUrl, readPath } from "../tool-fields"
import { toolFamily } from "../tool-identity"
import { commandText, type ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { FileChip, FileParent, useCount } from "./common"
import { useSearchText } from "./search"

type Bucket = "file" | "search" | "list" | "fetch"

const LIST_COMMAND = /^(?:ls|ll|tree|find|fd|du|pwd)\b/
const SEARCH_COMMAND = /^(?:rg|grep|egrep|fgrep|ag|ack)\b/

/** 一项查阅属于哪一类：读文件、搜索、列目录或网页抓取。 */
function bucketOf(tool: ToolCall): Bucket {
  const family = toolFamily(tool.name)
  if (family === "web-fetch") return "fetch"
  const name = tool.name.toLowerCase()
  if (family === "search") {
    return name === "glob" || name === "ls" || name === "list" || name === "find"
      ? "list"
      : "search"
  }
  if (family === "shell") {
    const command = (commandText(tool.input) ?? "").trim()
    if (SEARCH_COMMAND.test(command)) return "search"
    if (LIST_COMMAND.test(command)) return "list"
  }
  return "file"
}

/** 运行中摘要：最新一项的动作与对象。 */
function LatestChild({ tool }: { tool: ToolCall }) {
  const { t } = useLocale()
  const searchText = useSearchText()
  const family = toolFamily(tool.name)
  if (family === "file-read") {
    const path = readPath(tool)
    return (
      <>
        <span className="tool-row-action">{t("chat.toolCall.read.reading")}</span>
        {path ? <FileChip path={path} /> : null}
        {path ? <FileParent path={path} /> : null}
      </>
    )
  }
  if (family === "web-fetch") {
    return (
      <>
        <span className="tool-row-action">{t("chat.toolCall.webFetch.fetching")}</span>
        <span className="truncate">{fetchUrl(tool) ?? ""}</span>
      </>
    )
  }
  if (family === "shell") {
    return (
      <>
        <span className="tool-row-action">{t("chat.toolCall.execute.running")}</span>
        <code className="cmd-summary">{commandText(tool.input) ?? ""}</code>
      </>
    )
  }
  return (
    <>
      <span className="tool-row-action">{t("chat.toolCall.search.searching")}</span>
      <span className="truncate">{searchText(tool)}</span>
    </>
  )
}

/** 连续的查阅合成一行，展开后逐条列出。 */
export const ExploreGroup = memo(function ExploreGroup({
  tools,
  renderChild,
}: {
  tools: readonly ToolCall[]
  renderChild: (tool: ToolCall) => ReactNode
}) {
  const { t } = useLocale()
  const count = useCount()
  const running = tools.some((tool) => tool.status === "running")
  const totals: Record<Bucket, number> = { file: 0, search: 0, list: 0, fetch: 0 }
  for (const tool of tools) totals[bucketOf(tool)] += 1
  const summary = (["file", "search", "list", "fetch"] as const)
    .filter((bucket) => totals[bucket] > 0)
    .map((bucket) => count(`chat.toolCall.explore.${bucket}`, totals[bucket]))
    .join(", ")
  const latest = [...tools].reverse().find((tool) => tool.status === "running") ?? tools.at(-1)
  return (
    <ToolRow
      id={`explore-${tools[0]?.id ?? ""}`}
      icon={Search}
      kind={t("chat.toolCall.explore.label")}
      running={running}
      separator
      primary={running && latest ? <LatestChild tool={latest} /> : summary}
      expandedPrimary={summary}
      className="tool-group explore-group"
      dataStatus={running ? "running" : "completed"}
    >
      {() => <div className="tool-children">{tools.map((tool) => renderChild(tool))}</div>}
    </ToolRow>
  )
})
