/**
 * 线程级 MCP 桥：插件工具注册、按线程调用、Unix socket（Windows 命名管道）与 stdio 桥的启动命令。
 * 桥本身不关心是哪个 agent：会话拿到工具列表与调用入口，由 driver 接到自己 CLI 的 MCP 机制上。
 */
import { HOST_VERSION } from "@pigcode/plugin-sdk"
import type {
  McpBridgeApi,
  McpStdioServer,
  McpToolDefinition,
  McpToolHandler,
  SessionMcp,
} from "@pigcode/plugin-sdk"
import type { Context } from "cordis"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** 已注册工具及其处理函数。 */
interface RegisteredTool {
  tool: McpToolDefinition
  handler: McpToolHandler
}

/** socket server 句柄；close 关闭所有连接并清理 socket 文件。 */
export interface SocketServerHandle {
  socketPath: string
  close(): Promise<void>
}

/** Host 侧 MCP 桥；同时作为插件可见的 `mcp` 服务。 */
export interface McpBridgeService extends McpBridgeApi {
  /** 列出所有插件注册的工具；threadId 预留给后续按线程过滤。 */
  listTools(threadId?: string): McpToolDefinition[]
  /** 以指定线程身份调用工具；handler 会收到同一个 threadId。 */
  callTool(threadId: string, name: string, input: unknown): Promise<unknown>
  /** 启动（或复用）本地 socket 服务。 */
  createSocketServer(): Promise<SocketServerHandle>
  /** stdio 桥的启动命令；子进程用其中的 token 在 hello 时绑定到线程。 */
  stdioServer(threadId: string): McpStdioServer
  /** 一次会话可用的插件工具；没有任何工具时返回 undefined，Host 不注入空配置。 */
  sessionMcp(threadId: string): SessionMcp | undefined
}

declare module "cordis" {
  interface Context {
    mcpBridge: McpBridgeService
    mcp: McpBridgeApi
  }
}

/** socket 连接上的线程状态；hello 之前没有 threadId。 */
interface ConnectionState {
  threadId?: string
}

/** 注册 MCP 桥服务；`mcpBridge` 供 Host 使用，`mcp` 供插件使用。 */
export function apply(ctx: Context): void {
  /** pluginId → 工具名 → 注册项。 */
  const plugins = new Map<string, Map<string, RegisteredTool>>()
  /** hello token → threadId。 */
  const tokens = new Map<string, string>()
  /** threadId → token；同一会话复用同一个 token，避免每次 run 增长。 */
  const threadTokens = new Map<string, string>()
  /** 同一进程可能有多个 bridge（测试/多 profile）；socket 名带实例后缀避免冲突。 */
  const instanceId = randomUUID().slice(0, 8)
  const address = socketAddress(instanceId)
  const connections = new Set<net.Socket>()
  let server: net.Server | null = null
  let starting: Promise<SocketServerHandle> | null = null

  /** 查找工具；注册阶段已保证跨插件工具名唯一。 */
  function findTool(name: string): RegisteredTool | undefined {
    for (const byName of plugins.values()) {
      const entry = byName.get(name)
      if (entry) return entry
    }
    return undefined
  }

  function listTools(): McpToolDefinition[] {
    return [...plugins.values()].flatMap((byName) =>
      [...byName.values()].map((entry) => entry.tool),
    )
  }

  function registerTool(
    pluginId: string,
    tool: McpToolDefinition,
    handler: McpToolHandler,
  ): () => void {
    const owner = findTool(tool.name)
    if (owner && owner !== plugins.get(pluginId)?.get(tool.name)) {
      throw new Error(`MCP_TOOL_CONFLICT: ${tool.name}`)
    }
    const byName = plugins.get(pluginId) ?? new Map<string, RegisteredTool>()
    plugins.set(pluginId, byName)
    const registered: RegisteredTool = { tool, handler }
    byName.set(tool.name, registered)
    let active = true
    return () => {
      if (!active) return
      active = false
      // 只移除本次注册的条目，避免误删后来覆盖的同名工具。
      if (byName.get(tool.name) !== registered) return
      byName.delete(tool.name)
      if (byName.size === 0) plugins.delete(pluginId)
    }
  }

  async function callTool(threadId: string, name: string, input: unknown): Promise<unknown> {
    const entry = findTool(name)
    if (!entry) throw new Error(`unknown mcp tool: ${name}`)
    return entry.handler(input, { threadId })
  }

  /** stdio 桥的启动命令；token 在 hello 时映射回线程。 */
  function stdioServer(threadId: string): McpStdioServer {
    let token = threadTokens.get(threadId)
    if (!token) {
      token = randomUUID()
      threadTokens.set(threadId, token)
      tokens.set(token, threadId)
    }
    // 命令是同步返回的；socket 监听在后台启动，子进程连接时已就绪。
    void ensureSocketServer().catch(() => undefined)
    return {
      command: "node",
      args: [stdioBridgePath()],
      // 版本随启动命令传下去，stdio 桥用它填 serverInfo，不用自己依赖插件 SDK。
      env: { PIGCODE_MCP_SOCKET: address, PIGCODE_MCP_TOKEN: token, PIGCODE_VERSION: HOST_VERSION },
    }
  }

  /** 首次调用时创建监听；并发调用共享同一个启动 Promise。 */
  function ensureSocketServer(): Promise<SocketServerHandle> {
    if (starting) return starting
    if (server) return Promise.resolve(handle(address))
    starting = startSocketServer().finally(() => {
      starting = null
    })
    return starting
  }

  async function startSocketServer(): Promise<SocketServerHandle> {
    if (process.platform !== "win32") await rm(address, { force: true }).catch(() => undefined)
    const instance = net.createServer((socket) => {
      connections.add(socket)
      socket.on("close", () => connections.delete(socket))
      socket.on("error", () => socket.destroy())
      handleConnection(socket)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      instance.once("error", onError)
      instance.listen(address, () => {
        instance.off("error", onError)
        resolve()
      })
    })
    server = instance
    return handle(address)
  }

  /** 连接句柄：close 关闭 server、所有连接并清理 token。 */
  function handle(address: string): SocketServerHandle {
    return {
      socketPath: address,
      async close() {
        const instance = server
        server = null
        for (const socket of connections) socket.destroy()
        connections.clear()
        tokens.clear()
        threadTokens.clear()
        if (instance) {
          await new Promise<void>((resolve) => instance.close(() => resolve()))
        }
        if (process.platform !== "win32") await rm(address, { force: true }).catch(() => undefined)
      },
    }
  }

  /** 逐行处理 socket 上的 NDJSON 消息；首条必须是 hello。 */
  function handleConnection(socket: net.Socket): void {
    const state: ConnectionState = {}
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (line) void handleLine(socket, line, state)
      }
    })
  }

  async function handleLine(
    socket: net.Socket,
    line: string,
    state: ConnectionState,
  ): Promise<void> {
    const message = parseRecord(line)
    if (!message) {
      send(socket, { type: "error", message: "invalid JSON payload" })
      return
    }
    if (!state.threadId) {
      if (message.type !== "hello" || typeof message.token !== "string") {
        send(socket, { type: "error", message: "hello required" })
        socket.end()
        return
      }
      const threadId = tokens.get(message.token)
      if (!threadId) {
        send(socket, { type: "error", message: "invalid hello token" })
        socket.end()
        return
      }
      state.threadId = threadId
      send(socket, { type: "hello", ok: true })
      return
    }
    const reply = replyFor(message, state.threadId)
    send(socket, await reply)
  }

  /** 把一条请求映射为响应；id 原样回传便于桥接端匹配。 */
  async function replyFor(
    message: Record<string, unknown>,
    threadId: string,
  ): Promise<Record<string, unknown>> {
    const id = message.id
    const withId = (value: Record<string, unknown>): Record<string, unknown> =>
      id === undefined ? value : { ...value, id }
    switch (message.type) {
      case "tools/list":
        return withId({ type: "tools/list", tools: listTools() })
      case "tools/call": {
        if (typeof message.name !== "string") {
          return withId({ type: "tools/call", error: "tool name is required" })
        }
        try {
          const result = await callTool(threadId, message.name, message.arguments)
          return withId({ type: "tools/call", result })
        } catch (error) {
          return withId({ type: "tools/call", error: errorMessage(error) })
        }
      }
      case "ping":
        return withId({ type: "pong" })
      default:
        return withId({ type: "error", message: `unknown message type: ${String(message.type)}` })
    }
  }

  const service: McpBridgeService = {
    registerTool,
    listTools,
    callTool,
    createSocketServer: () => ensureSocketServer(),
    stdioServer,
    sessionMcp(threadId) {
      // 工具表在会话创建时取一份快照；插件启停对下一次 run 生效。
      const tools = listTools()
      if (tools.length === 0) return undefined
      return {
        tools,
        callTool: (name, input) => callTool(threadId, name, input),
        stdioServer: () => stdioServer(threadId),
      }
    },
  }

  ctx.provide("mcpBridge", service)
  // 插件拿到的就是 Cordis context；`mcp` 是 PluginHostContext.mcp 的运行时来源。
  ctx.provide("mcp", service)
  ctx.effect(() => () => {
    tokens.clear()
    threadTokens.clear()
    for (const socket of connections) socket.destroy()
    connections.clear()
    const instance = server
    server = null
    if (!instance) return
    instance.close(() => {
      if (process.platform !== "win32") void rm(address, { force: true }).catch(() => undefined)
    })
  })
}

/** socket 地址：Windows 使用命名管道，其余平台使用临时目录下的 Unix socket。 */
function socketAddress(instanceId: string): string {
  const name = `pigcode-mcp-${process.pid}-${instanceId}`
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
}

/** stdio 桥与 mcp-bridge bundle 位于同一 out/host 目录下的兄弟目录。 */
function stdioBridgePath(): string {
  return fileURLToPath(new URL("../mcp/stdio-bridge.mjs", import.meta.url))
}

/** 写入一行 JSON；连接已关闭时静默忽略。 */
function send(socket: net.Socket, value: Record<string, unknown>): void {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(value)}\n`)
}

/** 解析单行 JSON 对象；非法输入返回 null。 */
function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
