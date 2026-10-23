/** 按工具的展示族选择渲染器（参照 ZCode 的 resolveRenderer）。 */
import { memo } from "react"
import { toolFamily } from "../tool-identity"
import type { ToolCall } from "../tool-meta"
import { AskToolRow } from "./ask-question"
import { BrowserRow } from "./browser"
import { EditRow, ReadRow } from "./files"
import { McpRow } from "./mcp"
import { FallbackRow, SkillRow, TaskOutputRow, TaskStopRow } from "./misc"
import { PlanCard } from "./plan"
import { FetchRow, SearchRow } from "./search"
import { CommandRow } from "./shell"

export { BrowserGroup } from "./browser"
export { ExploreGroup } from "./explore"
export { CommandGroup } from "./shell"
export { QuestionHistoryRow } from "./ask-question"
export { ConversationActionsContext, useConversationActions } from "./common"
export type { ConversationActions } from "./common"

/** 渲染一个工具调用。live 是运行中命令已经流出的输出；分组里的子项不显示图标。 */
export const ToolBlock = memo(function ToolBlock({
  tool,
  live,
  showIcon = true,
}: {
  tool: ToolCall
  live?: string | undefined
  showIcon?: boolean | undefined
}) {
  switch (toolFamily(tool.name)) {
    case "shell":
      return <CommandRow tool={tool} live={live} showIcon={showIcon} />
    case "file-read":
      return <ReadRow tool={tool} showIcon={showIcon} />
    case "file-write":
      return <EditRow tool={tool} showIcon={showIcon} />
    case "search":
      return <SearchRow tool={tool} showIcon={showIcon} />
    case "web-fetch":
      return <FetchRow tool={tool} showIcon={showIcon} />
    case "ask-user-question":
      return <AskToolRow tool={tool} showIcon={showIcon} />
    case "skill":
      return <SkillRow tool={tool} showIcon={showIcon} />
    case "task-output":
      return <TaskOutputRow tool={tool} showIcon={showIcon} />
    case "task-stop":
      return <TaskStopRow tool={tool} showIcon={showIcon} />
    case "switch-mode":
      return <PlanCard tool={tool} />
    case "mcp":
      return <McpRow tool={tool} showIcon={showIcon} />
    case "browser":
      return <BrowserRow tool={tool} showIcon={showIcon} />
    default:
      return <FallbackRow tool={tool} showIcon={showIcon} />
  }
})
