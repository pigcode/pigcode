/**
 * clock_now 工具在对话时间线里的显示：登记一个工具渲染器。名字写 clock_now 就够了，宿主也用它匹配
 * Agent 报告的 mcp__pigcode__clock_now。插件停用后这一行回到宿主默认的显示。
 */
import type { ClientPluginContext, ClientToolCall } from "@pigcode/plugin-sdk"

const TEXT = {
  "zh-CN": {
    running: "正在读取时间",
    now: "当前时间",
    failed: "读取时间失败",
    stopped: "时间读取被中断",
  },
  "en-US": {
    running: "Reading the time",
    now: "Current time",
    failed: "Could not read the time",
    stopped: "Reading the time was interrupted",
  },
}

/**
 * 工具结果里的 ISO 时间。结果的形状由 Agent 决定（JSON 文字或 MCP 内容块），时间串在哪一种里都原样
 * 出现，直接从文字形式里找。
 */
function isoTime(call: ClientToolCall): string | undefined {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(call.output ?? "")?.[0]
}

export function apply(ctx: ClientPluginContext): () => void {
  return ctx.toolRenderers.register({
    id: "clock-now",
    tools: ["clock_now"],
    render(container, call) {
      const locale = ctx.locale.get()
      const text = locale.startsWith("en") ? TEXT["en-US"] : TEXT["zh-CN"]
      const iso = isoTime(call)
      if (call.status === "running") {
        container.append(ctx.ui.text(text.running, { tone: "muted", size: "sm" }))
      } else if (call.status === "completed" && iso) {
        const time = new Date(iso).toLocaleString(locale)
        container.append(ctx.ui.text(`${text.now} · ${time}`, { size: "sm" }))
      } else {
        const message = call.status === "stopped" ? text.stopped : text.failed
        container.append(ctx.ui.text(message, { tone: "muted", size: "sm" }))
      }
    },
  })
}
