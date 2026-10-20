#!/usr/bin/env node
/**
 * Pigcode 的 stdio MCP 桥。
 * 从 PIGCODE_MCP_SOCKET 连接 Host 的本地 socket，把 stdin 上的 MCP JSON-RPC
 * 转发给 Host，并把结果写回 stdout。Host 通过 token 识别调用线程。
 */
import net from "node:net"
import { createInterface } from "node:readline"

/** JSON-RPC / MCP 错误；code 直接写回客户端。 */
class BridgeError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
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
const pending = new Map()
let nextId = 1
let buffer = ""

socket.setEncoding("utf8")
socket.on("data", (chunk) => {
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
function handleHostLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message !== "object" || message === null) return
  if (message.id === undefined) {
    if (typeof message.message === "string") {
      process.stderr.write(`pigcode mcp bridge: ${message.message}\n`)
    }
    return
  }
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (typeof message.error === "string") waiter.reject(new Error(message.error))
  else waiter.resolve(message)
}

/** 发送一条 Host 协议消息并等待同 id 响应。 */
function hostRequest(payload) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.write(`${JSON.stringify({ ...payload, id })}\n`)
  })
}

/** 把 MCP 方法映射为 Host socket 请求。 */
async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pigcode", version: "0.1.0" },
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
        return {
          content: [{ type: "text", text: JSON.stringify(response.result) ?? "null" }],
        }
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

/** 逐行处理 stdin 上的 MCP 消息；通知不产生响应。 */
async function handleLine(line) {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    return
  }
  if (typeof message !== "object" || message === null) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    return
  }
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
        code: typeof error?.code === "number" ? error.code : -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/** 写一行 JSON-RPC 到 stdout。 */
function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

createInterface({ input: process.stdin }).on("line", (line) => {
  void handleLine(line)
})
