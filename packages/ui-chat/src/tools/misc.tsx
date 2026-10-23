/**
 * 其余工具行（参照 ZCode 的 skill / task-output / task-stop / fallback）：技能、后台任务的输出与
 * 停止，以及不认识的工具——展开后显示调用参数与结果。
 */
import { memo } from "react"
import { CircleStop, FileOutput, WandSparkles, Wrench } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import {
  humanizeName,
  outputText,
  skillFields,
  taskId,
  taskOutput,
  taskStopMessage,
} from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { headLines, toolStatusWord } from "./common"

interface RowProps {
  tool: ToolCall
  showIcon?: boolean | undefined
}

function statusOf(t: Parameters<typeof toolStatusWord>[0], tool: ToolCall) {
  return toolStatusWord(t, tool, headLines(outputText(tool)))
}

/** 技能：技能名与参数，展开后是技能信息与输出。 */
export const SkillRow = memo(function SkillRow({ tool, showIcon = true }: RowProps) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const { name, args } = skillFields(tool)
  const output = outputText(tool).trim()
  return (
    <ToolRow
      id={tool.id}
      icon={WandSparkles}
      showIcon={showIcon}
      kind={running ? t("chat.toolCall.skill.running") : t("chat.toolCall.kind.skill")}
      running={running}
      primary={<code className="mono">{name ?? t("chat.toolCall.skill.unknown")}</code>}
      secondary={args ? <code className="mono truncate">{args}</code> : null}
      hideSecondaryWhenOpen
      status={statusOf(t, tool)}
      dataStatus={tool.status}
    >
      {() => (
        <div className="tool-card">
          <div className="tool-card-field">
            <span className="tool-card-label">{t("chat.toolCall.kind.skill")}</span>
            <code className="tool-card-chip">{name ?? t("chat.toolCall.skill.unknown")}</code>
          </div>
          {args ? (
            <div className="tool-card-field is-block">
              <span className="tool-card-label">{t("chat.toolCall.skill.args")}</span>
              <pre className="tool-card-pre">{args}</pre>
            </div>
          ) : null}
          {output ? (
            <pre className="tool-card-pre is-output">{output}</pre>
          ) : running ? null : (
            <p className="tool-card-empty">{t("chat.toolCall.skill.noOutput")}</p>
          )}
        </div>
      )}
    </ToolRow>
  )
})

/** 后台任务的输出（BashOutput / TaskOutput）。 */
export const TaskOutputRow = memo(function TaskOutputRow({ tool, showIcon = true }: RowProps) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const id = taskId(tool)
  const result = taskOutput(tool)
  const outcome = running
    ? null
    : tool.status === "failed"
      ? t("chat.toolCall.taskOutput.taskFailed")
      : tool.status === "stopped"
        ? t("chat.toolCall.status.stopped")
        : result.status === "running"
          ? t("chat.toolCall.taskOutput.running")
          : result.status === "completed"
            ? t("chat.toolCall.taskOutput.completed")
            : result.status === "failed"
              ? t("chat.toolCall.taskOutput.taskFailed")
              : t("chat.toolCall.taskOutput.retrieved")
  return (
    <ToolRow
      id={tool.id}
      icon={FileOutput}
      showIcon={showIcon}
      kind={running ? t("chat.toolCall.taskOutput.fetching") : t("chat.toolCall.kind.taskOutput")}
      running={running}
      primary={id ? <code className="mono">{id}</code> : null}
      status={outcome ? { label: outcome } : null}
      dataStatus={tool.status}
    >
      {result.text
        ? () => (
            <div className="tool-card">
              <pre className="tool-card-pre is-output">{result.text}</pre>
            </div>
          )
        : undefined}
    </ToolRow>
  )
})

/** 停止后台任务（KillShell / TaskStop）。 */
export const TaskStopRow = memo(function TaskStopRow({ tool, showIcon = true }: RowProps) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const id = taskId(tool)
  const message = taskStopMessage(tool)
  return (
    <ToolRow
      id={tool.id}
      icon={CircleStop}
      showIcon={showIcon}
      kind={running ? t("chat.toolCall.taskStop.stopping") : t("chat.toolCall.kind.taskStop")}
      running={running}
      primary={id ? <code className="mono">{id}</code> : null}
      status={statusOf(t, tool)}
      dataStatus={tool.status}
    >
      {message
        ? () => (
            <div className="tool-card">
              <div className="tool-card-field is-block">
                <span className="tool-card-label">{t("chat.toolCall.taskStop.result")}</span>
                <p className="tool-card-text">{message}</p>
              </div>
            </div>
          )
        : undefined}
    </ToolRow>
  )
})

/** 不认识的工具：工具名，展开后是调用参数与结果。 */
export const FallbackRow = memo(function FallbackRow({ tool, showIcon = true }: RowProps) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const input = tool.input?.trim() === "{}" ? undefined : tool.input
  const output = outputText(tool).trim()
  const label = tool.name === "tool" ? t("chat.toolCall.toolCall") : humanizeName(tool.name)
  return (
    <ToolRow
      id={tool.id}
      icon={Wrench}
      showIcon={showIcon}
      kind={label}
      running={running}
      status={statusOf(t, tool)}
      title={tool.name}
      dataStatus={tool.status}
    >
      {input || output
        ? () => (
            <div className="tool-card">
              {input ? (
                <div className="tool-card-field is-block">
                  <span className="tool-card-label">{t("chat.toolCall.mcp.parameters")}</span>
                  <pre className="tool-card-pre">{input}</pre>
                </div>
              ) : null}
              {output ? (
                <div className="tool-card-field is-block">
                  <span className="tool-card-label">{t("chat.toolCall.mcp.result")}</span>
                  <pre className="tool-card-pre is-output">{output}</pre>
                </div>
              ) : null}
            </div>
          )
        : undefined}
    </ToolRow>
  )
})
