/**
 * 工作区里的各项（参照 ZCode 3.18 的 ConversationAssistantWorkItems）：思考、工具、过程消息、提问的
 * 历史行与子 agent 竖直排成一列，相邻两项隔 16；还在输出的思考接在最后。连续两项以上的思考与查阅、
 * 执行、修改在这里合成摘要组（summary-groups.ts），所以思考和工具的实时状态都能影响组头。
 */
import type { ReactNode } from "react"
import { MessageText } from "./message-item"
import { ReasoningBlock } from "./reasoning"
import { AgentRow } from "./subagent-card"
import { SummaryGroup } from "./summary-group"
import { groupSummaries } from "./summary-groups"
import { WorkflowRow } from "./workflow-card"
import { BuiltinToolBlock, QuestionHistoryRow, ToolBlock } from "./tools"
import type { WorkItem } from "./turns"

function WorkItemView({
  item,
  liveOutput,
  ended,
  showIcon = true,
}: {
  item: WorkItem
  liveOutput: Readonly<Record<string, string>> | undefined
  ended: boolean
  showIcon?: boolean
}) {
  switch (item.kind) {
    case "message":
      return (
        <div className="work-message md">
          <MessageText text={item.text} />
        </div>
      )
    case "reasoning":
      return (
        <ReasoningBlock
          id={item.key}
          text={item.text}
          durationMs={item.durationMs}
          streaming={item.streaming}
          showIcon={showIcon}
        />
      )
    case "tool":
      return <ToolBlock tool={item.tool} live={liveOutput?.[item.tool.id]} showIcon={showIcon} />
    case "subagent":
      return <AgentRow subagent={item.subagent} />
    case "workflow":
      return <WorkflowRow workflow={item.workflow} />
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

/** 组头里只画摘要的一项：工具只用内置的工具行，思考照常。 */
function previewOf(item: WorkItem): ReactNode {
  if (item.kind === "tool") return <BuiltinToolBlock tool={item.tool} />
  if (item.kind === "reasoning") {
    return (
      <ReasoningBlock
        id={`preview-${item.key}`}
        text={item.text}
        durationMs={item.durationMs}
        streaming={item.streaming}
      />
    )
  }
  return null
}

/**
 * 渲染一列工作。ended 表示这一轮已经结束；growing 表示这一轮还在跑、末尾还能接新的工作，末尾的摘要组
 * 因此还没闭合；liveReasoning 是还在输出的思考。
 */
export function WorkList({
  items,
  ended,
  growing = !ended,
  liveOutput,
  liveReasoning = "",
  className,
}: {
  items: readonly WorkItem[]
  ended: boolean
  growing?: boolean | undefined
  liveOutput?: Readonly<Record<string, string>> | undefined
  liveReasoning?: string | undefined
  className?: string | undefined
}) {
  const work: readonly WorkItem[] = liveReasoning.trim()
    ? [
        ...items,
        {
          kind: "reasoning",
          key: "live-reasoning",
          text: liveReasoning,
          durationMs: null,
          streaming: true,
        },
      ]
    : items
  const entries = groupSummaries(work)
  return (
    <div className={className ? `turn-work ${className}` : "turn-work"}>
      {entries.map((entry, index) =>
        entry.kind === "group" ? (
          <SummaryGroup
            key={entry.key}
            items={entry.items}
            tail={growing && index === entries.length - 1}
            renderItem={(item) => (
              <WorkItemView
                key={item.key}
                item={item}
                liveOutput={liveOutput}
                ended={ended}
                showIcon={false}
              />
            )}
            renderPreview={previewOf}
          />
        ) : (
          <WorkItemView key={entry.key} item={entry} liveOutput={liveOutput} ended={ended} />
        ),
      )}
    </div>
  )
}
