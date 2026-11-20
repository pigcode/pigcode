import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { McpServer } from "@agentclientprotocol/sdk"
import { HOST_VERSION, toolResultContent, type SessionMcp } from "@pigcode/plugin-sdk"

interface McpRequest {
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

async function readRequest(request: IncomingMessage): Promise<McpRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 2 * 1024 * 1024) throw new Error("MCP request is too large")
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpRequest
}

async function dispatch(request: McpRequest, mcp: SessionMcp): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pigcode", version: HOST_VERSION },
      }
    case "ping":
      return {}
    case "tools/list":
      return { tools: mcp.tools }
    case "tools/call": {
      const { name, arguments: input } = request.params ?? {}
      if (typeof name !== "string" || !mcp.tools.some((tool) => tool.name === name))
        throw new Error("Unknown Pigcode MCP tool")
      try {
        return toolResultContent(await mcp.callTool(name, input ?? {}))
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        }
      }
    }
    default:
      throw new Error("Unsupported MCP request")
  }
}

export interface SessionBridge {
  servers: McpServer[]
  close(): void
}

/** 优先使用 Agent 声明支持的本机 Streamable HTTP，工具按 Host 提供的会话身份调用。 */
export async function sessionBridge(
  mcp: SessionMcp | undefined,
  http: boolean,
): Promise<SessionBridge> {
  if (!mcp) return { servers: [], close() {} }
  if (!http) {
    const stdio = mcp.stdioServer()
    return {
      servers: [
        {
          name: "pigcode",
          command: stdio.command,
          args: stdio.args,
          env: Object.entries(stdio.env).map(([name, value]) => ({ name, value })),
        },
      ],
      close() {},
    }
  }
  const path = "/mcp/" + randomUUID()
  const server = createServer((req, res) => {
    if (
      req.url !== path ||
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== "http://" + host)
    ) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end()
      return
    }
    void (async () => {
      const request = await readRequest(req)
      if (request.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const reply = await dispatch(request, mcp).then(
        (result) => ({ result }),
        (error: unknown) => ({
          error: { code: -32602, message: error instanceof Error ? error.message : "MCP error" },
        }),
      )
      const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })
      res.writeHead(200, { "Content-Type": "application/json" }).end(body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400).end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Could not open Pigcode MCP bridge")
  }
  const host = "127.0.0.1:" + address.port
  server.unref()
  return {
    servers: [{ type: "http", name: "pigcode", url: "http://" + host + path, headers: [] }],
    close() {
      server.close()
      server.closeAllConnections()
    },
  }
}
