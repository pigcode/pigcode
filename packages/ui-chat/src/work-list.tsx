/**
 * 工作区里的各项（参照 ZCode 的 ConversationAssistantWorkItems）：思考、工具与合并后的分组、
 * 过程消息、提问的历史行与子 agent，竖直排成一列；正在输出的思考接在最后。
 */
import type { ReactNode } from "react"
import { MessageText } from "./message-item"
import { ReasoningBlock } from "./reasoning"
import { AgentRow } from "./subagent-card"
import type { ToolCall } from "./tool-meta"
import { BrowserGroup, CommandGroup, ExploreGroup, QuestionHistoryRow, ToolBlock } from "./tools"
import type { WorkItem } from "./turns"

const renderChild = (tool: ToolCall): ReactNode => (
  <ToolBlock key={tool.id} tool={tool} showIcon={false} />
)

function WorkItemView({
  item,
  liveOutput,
  ended,
}: {
  item: WorkItem
  liveOutput: Readonly<Record<string, string>> | undefined
  ended: boolean
}) {
  switch (item.kind) {
    case "message":
      return (
        <div className="work-message md">
          <MessageText text={item.text} />
        </div>
      )
    case "reasoning":
      return <ReasoningBlock id={item.key} text={item.text} durationMs={item.durationMs} />
    case "tool":
      return <ToolBlock tool={item.tool} live={liveOutput?.[item.tool.id]} />
    case "explore":
      return <ExploreGroup tools={item.tools} renderChild={renderChild} />
    case "commands":
      return <CommandGroup tools={item.tools} liveOutput={liveOutput} />
    case "browser":
      return <BrowserGroup tools={item.tools} renderChild={renderChild} />
    case "subagent":
      return <AgentRow subagent={item.subagent} />
    case "question":
      return (
        <QuestionHistoryRow
          request={item.request}
          answers={item.answers}
          pending={!ended && item.answers === undefined}
        />
      )
  }
}

/** 渲染一列工作；ended 表示这一轮已经结束，liveReasoning 是还在输出的思考。 */
export function WorkList({
  items,
  ended,
  liveOutput,
  liveReasoning = "",
  className,
}: {
  items: readonly WorkItem[]
  ended: boolean
  liveOutput?: Readonly<Record<string, string>> | undefined
  liveReasoning?: string | undefined
  className?: string | undefined
}) {
  return (
    <div className={className ? `turn-work ${className}` : "turn-work"}>
      {items.map((item) => (
        <WorkItemView key={item.key} item={item} liveOutput={liveOutput} ended={ended} />
      ))}
      {liveReasoning.trim() ? (
        <ReasoningBlock id="live-reasoning" text={liveReasoning} durationMs={null} streaming />
      ) : null}
    </div>
  )
}
