/** 验证 thread-scoped MCP bridge：插件工具注册、Claude server、socket 与 stdio 桥。 */
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apply as mcpBridge } from "./mcp-bridge"

/** 仓库内的 stdio 桥入口；构建时由 build-host.ts 编译到 out/host/mcp/stdio-bridge.mjs。 */
const BRIDGE_PATH = fileURLToPath(new URL("../mcp/stdio-bridge.ts", import.meta.url))

/** 所有测试创建的 context 与子进程，afterEach 统一回收。 */
const contexts: Context[] = []
const children: ChildProcessWithoutNullStreams[] = []

/** 创建只注册 mcp-bridge 的 Cordis context。 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(mcpBridge)
  contexts.push(ctx)
  return ctx
}

/** 注册一个最小 echo 工具；输入 schema 用 JSON Schema 描述。 */
const ECHO_TOOL = {
  name: "echo",
  description: "Echo the input",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** 读取 NDJSON 行的最小 socket 客户端。 */
function connectSocket(path: string): {
  send(message: unknown): void
  next(): Promise<Record<string, unknown>>
  close(): void
} {
  const socket = net.connect(path)
  const received: Record<string, unknown>[] = []
  const waiters: Array<(value: Record<string, unknown>) => void> = []
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) {
        const value = JSON.parse(line) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter(value)
        else received.push(value)
      }
      newline = buffer.indexOf("\n")
    }
  })
  return {
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`)
    },
    next() {
      const value = received.shift()
      if (value) return Promise.resolve(value)
      return new Promise((resolve) => waiters.push(resolve))
    },
    close() {
      socket.destroy()
    },
  }
}

/** 启动 stdio 桥子进程，按行读取 JSON-RPC 响应。 */
function startBridge(env: Record<string, string>): {
  child: ChildProcessWithoutNullStreams
  request(id: number, method: string, params?: unknown): Promise<Record<string, unknown>>
  notify(method: string, params?: unknown): void
  next(): Promise<Record<string, unknown>>
} {
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  children.push(child)
  const received: Record<string, unknown>[] = []
  const waiters: Array<(value: Record<string, unknown>) => void> = []
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return
    const value = JSON.parse(line) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else received.push(value)
  })
  const next = (): Promise<Record<string, unknown>> => {
    const value = received.shift()
    if (value) return Promise.resolve(value)
    return new Promise((resolve) => waiters.push(resolve))
  }
  return {
    child,
    async request(id, method, params) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      )
      return next()
    },
    notify(method, params) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
      )
    },
    next,
  }
}

/** stdio 桥的启动命令；Codex 这类以子进程连接 MCP 的 agent 用它。 */
function stdioServer(
  ctx: Context,
  threadId: string,
): { command: string; args: string[]; env: Record<string, string> } {
  return ctx.mcpBridge.stdioServer(threadId)
}

describe("mcp bridge", () => {
  it("registers, lists, calls and unregisters plugin tools", async () => {
    const ctx = await setup()
    const handler = vi.fn(async (input: unknown) => ({ echo: input }))
    const dispose = ctx.mcp.registerTool("plugin.echo", ECHO_TOOL, handler)

    expect(ctx.mcp.listTools()).toEqual([ECHO_TOOL])
    expect(ctx.mcpBridge.listTools("thread-1")).toEqual([ECHO_TOOL])
    await expect(ctx.mcpBridge.callTool("thread-1", "echo", { value: "hi" })).resolves.toEqual({
      echo: { value: "hi" },
    })
    expect(handler).toHaveBeenCalledWith({ value: "hi" }, { threadId: "thread-1" })

    dispose()
    expect(ctx.mcp.listTools()).toEqual([])
    expect(ctx.mcpBridge.listTools("thread-1")).toEqual([])
  })

  it("rejects duplicate tool names across plugins", async () => {
    const ctx = await setup()
    const dispose = ctx.mcp.registerTool("plugin.a", ECHO_TOOL, async () => ({}))
    expect(() => ctx.mcp.registerTool("plugin.b", ECHO_TOOL, async () => ({}))).toThrow(
      "MCP_TOOL_CONFLICT",
    )
    dispose()
  })

  it("hands sessions the tool list and a thread-scoped call only when tools exist", async () => {
    const ctx = await setup()
    expect(ctx.mcpBridge.sessionMcp("thread-1")).toBeUndefined()

    const handler = vi.fn(async (_input: unknown, call: { threadId: string }) => call.threadId)
    ctx.mcp.registerTool("plugin.echo", ECHO_TOOL, handler)
    const session = ctx.mcpBridge.sessionMcp("thread-1")
    expect(session?.tools).toEqual([ECHO_TOOL])
    await expect(session?.callTool("echo", { value: 1 })).resolves.toBe("thread-1")
    expect(session?.stdioServer().env.PIGCODE_MCP_TOKEN).toBe(
      ctx.mcpBridge.stdioServer("thread-1").env.PIGCODE_MCP_TOKEN,
    )
  })

  it("rejects unknown tools", async () => {
    const ctx = await setup()
    await expect(ctx.mcpBridge.callTool("thread-1", "missing", {})).rejects.toThrow(
      "unknown mcp tool: missing",
    )
  })

  it("passes the calling thread to the handler", async () => {
    const ctx = await setup()
    ctx.mcp.registerTool("plugin.who", { ...ECHO_TOOL, name: "who" }, async (_input, call) => {
      return call.threadId
    })

    await expect(ctx.mcpBridge.callTool("thread-a", "who", {})).resolves.toBe("thread-a")
    await expect(ctx.mcpBridge.callTool("thread-b", "who", {})).resolves.toBe("thread-b")
  })

  it("returns a stdio bridge command with a thread token", async () => {
    const ctx = await setup()
    ctx.mcp.registerTool("plugin.echo", ECHO_TOOL, async () => ({ ok: true }))
    const config = stdioServer(ctx, "thread-1")
    expect(config.command).toBe("node")
    expect(config.args[0]).toMatch(/stdio-bridge\.mjs$/)
    expect(config.env.PIGCODE_MCP_SOCKET).toBeTruthy()
    expect(config.env.PIGCODE_MCP_TOKEN).toBeTruthy()
  })

  it("serves tools/list and tools/call over the unix socket", async () => {
    const ctx = await setup()
    ctx.mcp.registerTool("plugin.who", { ...ECHO_TOOL, name: "who" }, async (_input, call) => ({
      threadId: call.threadId,
    }))
    await ctx.mcpBridge.createSocketServer()
    const config = stdioServer(ctx, "thread-socket")
    const socket = connectSocket(config.env.PIGCODE_MCP_SOCKET!)
    try {
      socket.send({ type: "hello", token: config.env.PIGCODE_MCP_TOKEN })
      expect(await socket.next()).toMatchObject({ type: "hello", ok: true })

      socket.send({ type: "tools/list" })
      const listed = await socket.next()
      expect(listed).toMatchObject({ type: "tools/list" })
      expect((listed.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["who"])

      socket.send({ type: "tools/call", name: "who", arguments: {} })
      expect(await socket.next()).toMatchObject({
        type: "tools/call",
        result: { threadId: "thread-socket" },
      })
    } finally {
      socket.close()
    }
  })

  it("keeps each thread's calls to its own identity", async () => {
    const ctx = await setup()
    ctx.mcp.registerTool("plugin.who", { ...ECHO_TOOL, name: "who" }, async (_input, call) => ({
      threadId: call.threadId,
    }))
    const handle = await ctx.mcpBridge.createSocketServer()
    const mine = stdioServer(ctx, "thread-a")
    const other = stdioServer(ctx, "thread-b")
    expect(mine.env.PIGCODE_MCP_TOKEN).not.toBe(other.env.PIGCODE_MCP_TOKEN)
    const socket = connectSocket(mine.env.PIGCODE_MCP_SOCKET!)
    try {
      socket.send({ type: "hello", token: mine.env.PIGCODE_MCP_TOKEN })
      expect(await socket.next()).toMatchObject({ type: "hello", ok: true })
      // 参数里写别的线程也没用：身份来自 hello 用的 token。
      socket.send({
        type: "tools/call",
        name: "who",
        arguments: { threadId: "thread-b" },
      })
      expect(await socket.next()).toMatchObject({
        type: "tools/call",
        result: { threadId: "thread-a" },
      })
    } finally {
      socket.close()
    }

    // 桥关了之后旧 token 不再有效，也不能再连上。
    await handle.close()
    const after = connectSocket(mine.env.PIGCODE_MCP_SOCKET!)
    after.send({ type: "hello", token: mine.env.PIGCODE_MCP_TOKEN })
    after.close()
  })

  it("bridges MCP JSON-RPC to the socket from stdio", async () => {
    const ctx = await setup()
    ctx.mcp.registerTool("plugin.echo", ECHO_TOOL, async (input, call) => ({
      input,
      threadId: call.threadId,
    }))
    await ctx.mcpBridge.createSocketServer()
    const config = stdioServer(ctx, "thread-stdio")
    const bridge = startBridge({
      PIGCODE_MCP_SOCKET: config.env.PIGCODE_MCP_SOCKET!,
      PIGCODE_MCP_TOKEN: config.env.PIGCODE_MCP_TOKEN!,
    })

    expect(await bridge.request(1, "initialize", { protocolVersion: "2025-06-18" })).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "pigcode", version: "0.1.0" },
      },
    })
    bridge.notify("notifications/initialized")

    const listed = await bridge.request(2, "tools/list")
    expect(listed).toMatchObject({ id: 2, result: { tools: [{ name: "echo" }] } })

    const called = await bridge.request(3, "tools/call", {
      name: "echo",
      arguments: { value: "hi" },
    })
    expect(called).toMatchObject({ id: 3, result: { content: [{ type: "text" }] } })
    const content = (called.result as { content: Array<{ text: string }> }).content[0]!
    expect(JSON.parse(content.text)).toEqual({ input: { value: "hi" }, threadId: "thread-stdio" })

    expect(await bridge.request(4, "ping")).toMatchObject({ id: 4, result: {} })

    const unknown = await bridge.request(5, "unknown/method")
    expect(unknown).toMatchObject({ id: 5, error: { code: -32601 } })
  })

  it("exits when stdin closes", async () => {
    const ctx = await setup()
    ctx.mcp.registerTool("plugin.echo", ECHO_TOOL, async () => ({}))
    await ctx.mcpBridge.createSocketServer()
    const config = stdioServer(ctx, "thread-stdio-close")
    const bridge = startBridge({
      PIGCODE_MCP_SOCKET: config.env.PIGCODE_MCP_SOCKET!,
      PIGCODE_MCP_TOKEN: config.env.PIGCODE_MCP_TOKEN!,
    })

    bridge.child.stdin.end()
    const code = await new Promise<number | null>((resolve) => {
      bridge.child.once("exit", (exitCode) => resolve(exitCode))
    })

    expect(code).toBe(0)
  })

  it("exits with a readable error when the socket env is missing", async () => {
    const env = { ...process.env }
    delete env.PIGCODE_MCP_SOCKET
    delete env.PIGCODE_MCP_TOKEN
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    children.push(child as unknown as ChildProcessWithoutNullStreams)
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve))
    expect(code).toBe(1)
    expect(stderr).toContain("PIGCODE_MCP_SOCKET")
  })
})
