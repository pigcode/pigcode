/**
 * 会话提示（#57）：还能继续，但有东西没接上。目前只有一个来源——插件工具的 MCP 桥起不来。
 * Codex 用 `mcpServer/startupStatus/updated` 报告它，这条通知在 thread/start 之后就到，
 * 那时还没有 run，所以先攒在 session 里，下一次 send 的开头补发（事件必须带 runId）。
 */
import type { AgentRuntime } from "@pigcode/plugin-sdk"

/** 插件工具的 MCP server 名；只有它起不来才提示用户，用户自己配置的 server 不归 Pigcode 管。 */
export const PLUGIN_MCP_SERVER = "pigcode"

/** 一条会话提示；只给稳定的键，文案由界面按语言选取。 */
export interface SessionNotice {
  level: "info" | "warning" | "error"
  key: string
  params?: Record<string, string>
}

/** session 里的提示状态。 */
export interface NoticeState {
  /** 还没告诉用户的提示。 */
  pending: SessionNotice[]
  /** 已经提示过的键：app-server 会重试启动，同一个问题只该说一次。 */
  told: Set<string>
}

/**
 * 把 `mcpServer/startupStatus/updated` 映射成一条会话提示：只有插件工具的桥启动失败才算。
 * app-server 还会为每个自己配置的 server 发 starting/ready，那些不是用户要关心的事。
 */
export function mcpStartupNotice(params: unknown): SessionNotice | null {
  const record = params as { name?: unknown; status?: unknown } | null
  if (record?.name !== PLUGIN_MCP_SERVER || record.status !== "failed") return null
  // 只带 server 名：原始 error 是英文的 app-server 报文，用户要它的时候去日志里看。
  return { level: "warning", key: "mcp.bridge.failed", params: { name: PLUGIN_MCP_SERVER } }
}

/** 记下一条提示，等下一次 send 补发；同一个问题只记一次。 */
export function rememberNotice(state: NoticeState, notice: SessionNotice): void {
  if (state.told.has(notice.key)) return
  if (state.pending.some((item) => item.key === notice.key)) return
  state.pending.push(notice)
}

/** 补发攒下的提示；调用方保证此刻已经在 run 里。 */
export function flushNotices(state: NoticeState, runtime: AgentRuntime): void {
  for (const notice of state.pending.splice(0)) emitNotice(state, runtime, notice)
}

/** 推送一条提示；同一个 session 里同一个键只说一次。 */
export function emitNotice(state: NoticeState, runtime: AgentRuntime, notice: SessionNotice): void {
  if (state.told.has(notice.key)) return
  state.told.add(notice.key)
  runtime.emit({ type: "notice", ...notice })
}
