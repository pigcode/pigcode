/**
 * 搜索与网页抓取（参照 ZCode 的 search / web-fetch）：都只有一行摘要，不能展开。
 * 搜索显示查找的内容或列出的目录，网页抓取只显示网址。
 */
import { memo } from "react"
import { Globe, Search } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { fetchUrl, outputText, searchSummary } from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { headLines, toolStatusWord } from "./common"

/** 搜索摘要的文字：「查找 xxx」「列出 dir」「搜索工具：a, b」。 */
export function useSearchText(): (tool: ToolCall) => string {
  const { t } = useLocale()
  return (tool) => {
    const summary = searchSummary(tool)
    if (summary.kind === "tools") {
      return summary.text
        ? t("chat.toolCall.search.toolsWithQuery").replace("{query}", summary.text)
        : t("chat.toolCall.search.tools")
    }
    if (summary.kind === "list") {
      return summary.text
        ? t("chat.toolCall.search.listIn").replace("{cwd}", summary.text)
        : t("chat.toolCall.search.list")
    }
    return summary.text || t("chat.toolCall.search.find")
  }
}

/** 搜索（Grep、Glob、LS、网页搜索）。 */
export const SearchRow = memo(function SearchRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const text = useSearchText()(tool)
  const running = tool.status === "running"
  const tools = searchSummary(tool).kind === "tools"
  return (
    <ToolRow
      id={tool.id}
      icon={Search}
      showIcon={showIcon}
      kind={
        tools ? "" : running ? t("chat.toolCall.search.searching") : t("chat.toolCall.kind.search")
      }
      running={running}
      primary={<span className="truncate">{text}</span>}
      status={toolStatusWord(t, tool, headLines(outputText(tool)))}
      title={text}
      dataStatus={tool.status}
    />
  )
})

/** 网页抓取：只显示网址。 */
export const FetchRow = memo(function FetchRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const url = fetchUrl(tool) ?? ""
  const running = tool.status === "running"
  return (
    <ToolRow
      id={tool.id}
      icon={Globe}
      showIcon={showIcon}
      kind={running ? t("chat.toolCall.webFetch.fetching") : t("chat.toolCall.kind.webFetch")}
      running={running}
      primary={<span className="truncate">{url}</span>}
      status={toolStatusWord(t, tool, headLines(outputText(tool)))}
      title={url}
      dataStatus={tool.status}
    />
  )
})
