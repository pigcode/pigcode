/**
 * MCP 工具（参照 ZCode 的 mcp）：「MCP · 服务 · 工具」，运行中「MCP」扫光。展开后先是结果——
 * 简短的结果一张小卡片，长结果或 JSON 用带复制与换行的代码块，图片直接显示——再是可展开的
 * 「查看调用详情」，里面是调用参数。
 */
import { memo, useState } from "react"
import { ChevronRight, Plug } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { CodeBlock } from "../code-block"
import { humanizeName, mcpCall, type McpCall } from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { headLines, toolStatusWord } from "./common"

function McpResult({ call, failed }: { call: McpCall; failed: boolean }) {
  const { t } = useLocale()
  if (failed) {
    return (
      <div className="mcp-error" role="alert">
        <span className="tool-card-label">{t("chat.toolCall.status.failed")}</span>
        <pre>{call.text}</pre>
      </div>
    )
  }
  const compact = call.text.length <= 160 && !call.text.includes("\n") && !call.json
  return (
    <>
      {call.images.length > 0 ? (
        <div className="tool-row-images">
          {call.images.map((src, index) => (
            <img key={index} src={src} alt={t("chat.tool.screenshot")} loading="lazy" />
          ))}
        </div>
      ) : null}
      {call.text ? (
        compact ? (
          <div className="mcp-compact">{call.text}</div>
        ) : (
          <CodeBlock
            code={call.text}
            language={call.json ? "json" : ""}
            label={t("chat.toolCall.mcp.result")}
            compact
          />
        )
      ) : null}
    </>
  )
}

function CallDetails({ call }: { call: McpCall }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  if (!call.args || Object.keys(call.args).length === 0) return null
  return (
    <div className="mcp-details">
      <button
        type="button"
        className="mcp-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className="ic ic-xs" aria-hidden="true" />
        {t("chat.toolCall.mcp.callDetails")}
      </button>
      {open ? (
        <div className="mcp-details-body">
          <span className="tool-card-label">{t("chat.toolCall.mcp.parameters")}</span>
          <CodeBlock
            code={JSON.stringify(call.args, null, 2)}
            language="json"
            label="json"
            compact
          />
        </div>
      ) : null}
    </div>
  )
}

/** MCP 工具调用。 */
export const McpRow = memo(function McpRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const call = mcpCall(tool)
  if (!call) return null
  const running = tool.status === "running"
  const failed = tool.status === "failed"
  const hasBody = Boolean(call.text || call.images.length > 0 || call.args)
  return (
    <ToolRow
      id={tool.id}
      icon={Plug}
      showIcon={showIcon}
      kind="MCP"
      running={running}
      kindDetail={<span className="tool-row-server">{humanizeName(call.server)}</span>}
      separator
      primary={humanizeName(call.tool)}
      status={toolStatusWord(t, tool, headLines(call.text))}
      title={tool.name}
      dataStatus={tool.status}
    >
      {hasBody && !running
        ? () => (
            <div className="mcp-body">
              <McpResult call={call} failed={failed} />
              <CallDetails call={call} />
            </div>
          )
        : undefined}
    </ToolRow>
  )
})
