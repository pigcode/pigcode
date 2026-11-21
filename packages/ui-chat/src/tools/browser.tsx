/**
 * 内置浏览器的操作行：每一步是动作和对象（打开网页、点击、输入…），截图的结果默认展开。
 * 和 ZCode 的 BUA 一样算「执行」，和前后的命令、查阅连成一个摘要组。
 */
import { memo } from "react"
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
