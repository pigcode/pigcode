/**
 * 插件 MCP 工具在 Host 与 agent 之间流转的形状，不依赖任何 agent 的 SDK：
 * 支持进程内 MCP 的 agent（Claude Code）用 tools + callTool 自己建 server，
 * 以子进程连接 MCP 的 agent（Codex）用 stdioServer 的启动命令。
 */

/** 插件通过 MCP 暴露给模型的工具定义；inputSchema 使用 JSON Schema。 */
export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** MCP 内容块：文字或图片。 */
export type McpContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

/** stdio MCP server 的启动命令；Host 侧的 socket 在第一次取命令时才开始监听。 */
export interface McpStdioServer {
  command: string
  args: string[]
  env: Record<string, string>
}

/** 一个会话可用的插件工具；调用都带着发起会话的线程。没有插件工具时 Host 不传。 */
export interface SessionMcp {
  tools: McpToolDefinition[]
  /** 结果可以是任意可序列化的值，或者已经是 MCP 的 `{ content: [...] }`。 */
  callTool(name: string, input: unknown): Promise<unknown>
  stdioServer(): McpStdioServer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 工具结果转成 MCP 内容：已经是 `{ content: [...] }` 的原样交出（例如截图），
 * 其余结果序列化成一段 JSON 文字。
 */
export function toolResultContent(result: unknown): { content: McpContent[]; isError?: true } {
  if (isRecord(result) && Array.isArray(result.content)) {
    const content = result.content.filter(
      (item): item is McpContent =>
        isRecord(item) &&
        ((item.type === "text" && typeof item.text === "string") ||
          (item.type === "image" &&
            typeof item.data === "string" &&
            typeof item.mimeType === "string")),
    )
    if (content.length > 0) {
      return { content, ...(result.isError === true ? { isError: true } : {}) }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] }
}
