/**
 * clock_now 工具在对话时间线里的显示：登记一个工具渲染器，内容是宿主的 React 与 ui-primitives（ADR-0002）。
 * 名字写 clock_now 就够了，宿主也用它匹配 Agent 报告的 mcp__pigcode__clock_now。插件停用后这一行回到
 * 宿主默认的显示。
 */
import { useLocale } from "@pigcode/ui-primitives"
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
function isoTime(tool: ClientToolCall): string | undefined {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(tool.output ?? "")?.[0]
}

/** 时间线里的一行：运行中、读到了时间，或失败与中断各一句。 */
function ClockNow({ tool }: { tool: ClientToolCall }) {
  const { locale } = useLocale()
  const text = locale.startsWith("en") ? TEXT["en-US"] : TEXT["zh-CN"]
  const iso = isoTime(tool)
  // 时间和界面语言一致，和宿主的其它时间显示用同一个 Intl 参数。
  const message =
    tool.status === "running"
      ? text.running
      : tool.status === "completed" && iso
        ? `${text.now} · ${new Date(iso).toLocaleString(locale)}`
        : tool.status === "stopped"
          ? text.stopped
          : text.failed
  return <p className="hint">{message}</p>
}

export function apply(ctx: ClientPluginContext): () => void {
  return ctx.toolRenderers.register({
    id: "clock-now",
    tools: ["clock_now"],
    Component: ClockNow,
  })
}
