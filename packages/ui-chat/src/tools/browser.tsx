/**
 * 内置浏览器的操作行：每一步是「动作 · 对象」（打开网页、点击、输入…），截图的结果默认展开；
 * 连续的操作合成「浏览器 · 网站 · N 步」，形式与 ZCode 的电脑控制分组一致。
 */
import { memo, type ReactNode } from "react"
import { Globe } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { browserPreview, browserVisual, toolOutputParts, type ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { headLines, toolStatusWord } from "./common"

/** 浏览器的一步操作。 */
export const BrowserRow = memo(function BrowserRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const output = toolOutputParts(tool.output)
  const visual = browserVisual(tool.name)
  const running = tool.status === "running"
  const preview = browserPreview(tool)
  const text = output.text.trim()
  return (
    <ToolRow
      id={tool.id}
      icon={visual.icon}
      showIcon={showIcon}
      kind={visual.label ? t(visual.label) : tool.name}
      running={running}
      primary={preview ? <span className="truncate">{preview}</span> : null}
      status={toolStatusWord(t, tool, headLines(text))}
      autoOpen={output.images.length > 0}
      dataStatus={tool.status}
    >
      {output.images.length > 0 || text
        ? () => (
            <div className="browser-body">
              {output.images.length > 0 ? (
                <div className="tool-row-images">
                  {output.images.map((src, index) => (
                    <img key={index} src={src} alt={t("chat.tool.screenshot")} loading="lazy" />
                  ))}
                </div>
              ) : null}
              {text && output.images.length === 0 ? (
                <pre className="tool-card-pre is-output">{text}</pre>
              ) : null}
            </div>
          )
        : undefined}
    </ToolRow>
  )
})

/** 连续的浏览器操作合成一行，展开后逐步列出。 */
export const BrowserGroup = memo(function BrowserGroup({
  tools,
  renderChild,
}: {
  tools: readonly ToolCall[]
  renderChild: (tool: ToolCall) => ReactNode
}) {
  const { t } = useLocale()
  const running = tools.some((tool) => tool.status === "running")
  const failed = tools.some((tool) => tool.status === "failed")
  const site = tools
    .filter((tool) => /browser_(open|navigate)$/.test(tool.name))
    .map((tool) => browserPreview(tool))
    .find(Boolean)
  const summary = [site, t("chat.tool.browser.steps").replace("{count}", String(tools.length))]
    .filter(Boolean)
    .join(" · ")
  return (
    <ToolRow
      id={`browser-${tools[0]?.id ?? ""}`}
      icon={Globe}
      kind={t("chat.toolCall.browser.label")}
      running={running}
      separator
      primary={summary}
      className="tool-group browser-group"
      dataStatus={running ? "running" : failed ? "failed" : "completed"}
    >
      {() => <div className="tool-children">{tools.map((tool) => renderChild(tool))}</div>}
    </ToolRow>
  )
})
