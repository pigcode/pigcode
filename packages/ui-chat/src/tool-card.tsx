/** 工具调用卡片；查看按钮展开输入与输出。 */
import { useState } from "react"
import { Wrench } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"

/** 工具调用的生命周期状态。 */
export type ToolStatus = "running" | "completed" | "failed"

/** 时间线里一张工具卡片需要的数据。 */
export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  input: string | undefined
  output: string | undefined
}

const STATUS_KEYS = {
  running: "chat.tool.running",
  completed: "chat.tool.completed",
  failed: "chat.tool.failed",
} as const

/** 渲染工具调用；有输入或输出时允许展开查看。 */
export function ToolCard({
  tool,
  onView,
}: {
  tool: ToolCall
  onView?: ((tool: ToolCall) => void) | undefined
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const hasDetails = Boolean(tool.input || tool.output)

  function toggle(): void {
    onView?.(tool)
    if (hasDetails) setOpen((value) => !value)
  }

  return (
    <div className="tool-card" data-status={tool.status}>
      <Button
        variant="plain"
        className="tool-head"
        type="button"
        aria-expanded={open}
        onClick={toggle}
      >
        <Wrench className="ic ic-sm" aria-hidden="true" />
        <span className="tool-name">
          {tool.name === "tool" ? t("chat.tool.unknown") : tool.name}
        </span>
        <span className={`tool-status ${tool.status}`}>{t(STATUS_KEYS[tool.status])}</span>
        <span className="grow" />
        {hasDetails ? (
          <span className="muted">{open ? t("chat.hide") : t("chat.view")}</span>
        ) : null}
      </Button>
      {open ? (
        <div className="tool-body">
          {tool.input ? (
            <>
              <div className="tool-label">{t("chat.tool.input")}</div>
              <pre>{tool.input}</pre>
            </>
          ) : null}
          {tool.output ? (
            <>
              <div className="tool-label">{t("chat.tool.output")}</div>
              <pre>{tool.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
