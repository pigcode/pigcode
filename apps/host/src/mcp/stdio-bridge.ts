#!/usr/bin/env node
/**
 * Pigcode 的 stdio MCP 桥。
 * 从 PIGCODE_MCP_SOCKET 连接 Host 的本地 socket，把 stdin 上的 MCP JSON-RPC
 * 转发给 Host，并把结果写回 stdout。Host 通过 token 识别调用线程。
 *
 * 这个文件由 Codex/Claude 以独立 node 子进程启动，只能依赖 Node 内置模块；
 * 构建时 build-host 把它转成 out/host/mcp/stdio-bridge.mjs。
 */
import net from "node:net"
import { createInterface } from "node:readline"

/** JSON-RPC / MCP 错误；code 直接写回客户端。 */
class BridgeError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

/** Host socket 上的一条响应；id 对应桥内请求。 */
interface HostMessage {
  id?: number
  error?: unknown
  message?: unknown
  tools?: unknown
  result?: unknown
}

/** 等待中的 Host 请求。 */
interface Waiter {
  resolve: (message: HostMessage) => void
  reject: (error: Error) => void
}

/** stdin 上的一条 MCP JSON-RPC 消息。 */
interface RpcMessage {
  id?: string | number | null
  method?: unknown
  params?: Record<string, unknown>
}

const socketPath = process.env.PIGCODE_MCP_SOCKET
const token = process.env.PIGCODE_MCP_TOKEN

if (!socketPath || !token) {
  process.stderr.write(
    "pigcode mcp bridge: PIGCODE_MCP_SOCKET and PIGCODE_MCP_TOKEN are required\n",
  )
  process.exit(1)
}

const socket = net.connect(socketPath)
/** 等待 Host 响应的请求；key 为桥内自增 id。 */
const pending = new Map<number, Waiter>()
let nextId = 1
let buffer = ""

socket.setEncoding("utf8")
socket.on("data", (chunk: string) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (line) handleHostLine(line)
  }
})
socket.on("error", (error) => {
  process.stderr.write(`pigcode mcp bridge: ${error.message}\n`)
  process.exit(1)
})
socket.on("close", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("host socket closed"))
  pending.clear()
  process.exit(1)
})
socket.write(`${JSON.stringify({ type: "hello", token })}\n`)

/** 处理 Host 返回的一行 JSON；按 id 唤醒等待中的请求。 */
function handleHostLine(line: string): void {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message !== "object" || message === null) return
  const value = message as HostMessage
  if (value.id === undefined) {
    if (typeof value.message === "string") {
      process.stderr.write(`pigcode mcp bridge: ${value.message}\n`)
    }
    return
  }
  const waiter = pending.get(value.id)
  if (!waiter) return
  pending.delete(value.id)
  if (typeof value.error === "string") waiter.reject(new Error(value.error))
  else waiter.resolve(value)
}

/** 发送一条 Host 协议消息并等待同 id 响应。 */
function hostRequest(payload: Record<string, unknown>): Promise<HostMessage> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.write(`${JSON.stringify({ ...payload, id })}\n`)
  })
}

/** 把 MCP 方法映射为 Host socket 请求。 */
async function dispatch(
  method: unknown,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        // 版本由 Host 在启动命令里传进来：这个脚本会被单独起成子进程，不引插件 SDK 的包。
        serverInfo: { name: "pigcode", version: process.env.PIGCODE_VERSION ?? "0.0.0-dev" },
      }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined
    case "ping":
      return {}
    case "tools/list": {
      const response = await hostRequest({ type: "tools/list" })
      return { tools: Array.isArray(response.tools) ? response.tools : [] }
    }
    case "tools/call": {
      if (typeof params?.name !== "string") {
        throw new BridgeError("tools/call requires a tool name", -32602)
      }
      try {
        const response = await hostRequest({
          type: "tools/call",
          name: params.name,
          arguments: params.arguments ?? {},
        })
        return resultContent(response.result)
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        }
      }
    }
    default:
      throw new BridgeError(`unknown method: ${String(method)}`, -32601)
  }
}

/** 已经是 MCP 内容（`{ content: [...] }`，例如截图）的结果原样交出，其余序列化成文字。 */
function resultContent(result: unknown): { content: unknown[] } {
  if (typeof result === "object" && result !== null) {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content) && content.length > 0) return { content }
  }
  return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] }
}

/** 逐行处理 stdin 上的 MCP 消息；通知不产生响应。 */
async function handleLine(line: string): Promise<void> {
  if (!line.trim()) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    return
  }
  if (typeof parsed !== "object" || parsed === null) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    return
  }
  const message = parsed as RpcMessage
  const isRequest = message.id !== undefined && message.id !== null
  try {
    const result = await dispatch(message.method, message.params)
    if (isRequest) write({ jsonrpc: "2.0", id: message.id, result })
  } catch (error) {
    if (!isRequest) return
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: error instanceof BridgeError ? error.code : -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/** 写一行 JSON-RPC 到 stdout。 */
function write(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const input = createInterface({ input: process.stdin })
input.on("line", (line) => {
  void handleLine(line)
})
// MCP host 通过关闭 stdin/SIGTERM 结束 bridge；主动退出，避免 socket 让进程悬挂。
let closing = false
function shutdown(): void {
  if (closing) return
  closing = true
  input.close()
  socket.end()
  process.exit(0)
}
input.on("close", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
