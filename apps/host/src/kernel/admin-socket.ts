/**
 * 本机控制通道（host.sock / Windows 命名管道）：
 * 使用换行分隔的 JSON（NDJSON）服务本机 CLI 与诊断工具的运行态查询及控制请求。
 */
import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { dirname } from "node:path"
import {
  hostAdminMethodParamsSchemas,
  hostAdminRequestSchema,
  hostAdminResponseSchema,
  type HostAdminMethod,
  type HostAdminParams,
  type HostAdminResultMap,
} from "@pigcode/contracts"
import { canConnectSocket } from "./host-lock"

/** 单行 NDJSON 最大字节数（256 KiB），避免异常输入撑爆内存。 */
const MAX_LINE_BYTES = 256 * 1024
const DEFAULT_CALL_TIMEOUT_MS = 15_000

/** 每个控制方法对应的处理函数映射。 */
export type AdminHandlers = {
  [M in HostAdminMethod]: (
    params: HostAdminParams<M>,
  ) => Promise<HostAdminResultMap[M]> | HostAdminResultMap[M]
}

/** 已启动的本机控制通道服务端句柄。 */
export interface AdminSocketServer {
  readonly endpoint: string
  close(): Promise<void>
}

/** 客户端调用失败（协议错、服务端返回错误、超时或连接断开）。 */
export class AdminClientError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = "AdminClientError"
    this.code = code
  }
}

/** 服务端处理器抛出的带结构化错误码的异常。 */
export class AdminHandlerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "AdminHandlerError"
    this.code = code
  }
}

function sendLine(socket: Socket, payload: unknown): void {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(payload)}\n`)
  } catch {
    // 客户端已提前断开时静默忽略写入异常。
  }
}

function extractRequestId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const candidate = (raw as { id: unknown }).id
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return "unknown"
}

function extractErrorCode(error: unknown): string {
  if (error instanceof AdminHandlerError) return error.code
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code.length > 0
  ) {
    return (error as { code: string }).code
  }
  return "INTERNAL_ERROR"
}

async function dispatchAdminLine(line: string, handlers: AdminHandlers): Promise<unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return {
      id: "unknown",
      ok: false,
      error: "Malformed JSON request",
      code: "INVALID_JSON",
    }
  }

  const parsedRequest = hostAdminRequestSchema.safeParse(raw)
  if (!parsedRequest.success) {
    return {
      id: extractRequestId(raw),
      ok: false,
      error: "Invalid request envelope",
      code: "INVALID_REQUEST",
    }
  }

  const { id, method, params } = parsedRequest.data
  if (!Object.hasOwn(hostAdminMethodParamsSchemas, method)) {
    return {
      id,
      ok: false,
      error: `Unknown admin method: ${method}`,
      code: "METHOD_NOT_FOUND",
    }
  }

  const typedMethod = method as HostAdminMethod
  const schema = hostAdminMethodParamsSchemas[typedMethod]
  const parsedParams = schema.safeParse(params === undefined ? {} : params)
  if (!parsedParams.success) {
    return {
      id,
      ok: false,
      error: parsedParams.error.issues[0]?.message || "Invalid parameters",
      code: "INVALID_PARAMS",
    }
  }

  try {
    const handler = handlers[typedMethod] as (value: unknown) => Promise<unknown> | unknown
    const result = await handler(parsedParams.data)
    return { id, ok: true, result }
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : String(error || "Internal server error")
    return {
      id,
      ok: false,
      error: message,
      code: extractErrorCode(error),
    }
  }
}

function removePosixEndpointIfNeeded(endpoint: string): void {
  if (process.platform === "win32") return
  try {
    rmSync(endpoint, { force: true })
  } catch {
    // 忽略关闭后的残留清理失败。
  }
}

function endpointExistsOnDisk(endpoint: string): boolean {
  try {
    lstatSync(endpoint)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/**
 * 启动本机控制通道服务端。
 * POSIX 下会检查并拒绝覆盖仍在监听的 socket，仅清理失活的残留文件，并将权限收紧为 `0o600`。
 */
export async function startAdminSocketServer(
  endpoint: string,
  handlers: AdminHandlers,
): Promise<AdminSocketServer> {
  if (process.platform !== "win32") {
    mkdirSync(dirname(endpoint), { recursive: true })
    if (endpointExistsOnDisk(endpoint)) {
      if (await canConnectSocket(endpoint, 400)) {
        throw new Error(`Admin socket already active at ${endpoint}`)
      }
      rmSync(endpoint, { force: true })
    }
  }

  const clients = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket)
    let buffer: Buffer = Buffer.alloc(0)
    let pending = 0
    let clientEnded = false
    let rejected = false

    const maybeFinishHalfOpen = (): void => {
      if (clientEnded && pending === 0 && !socket.destroyed) {
        socket.end()
      }
    }

    socket.on("error", () => {
      // 对端探测连接后立刻 destroy 时触发的 ECONNRESET / EPIPE 忽略即可。
    })
    socket.once("close", () => {
      clients.delete(socket)
    })
    socket.on("end", () => {
      clientEnded = true
      if (!rejected && buffer.length > 0) {
        const trailing = buffer.toString("utf8").trim()
        buffer = Buffer.alloc(0)
        if (trailing) {
          pending += 1
          void dispatchAdminLine(trailing, handlers)
            .then((response) => sendLine(socket, response))
            .finally(() => {
              pending -= 1
              maybeFinishHalfOpen()
            })
          return
        }
      }
      maybeFinishHalfOpen()
    })

    socket.on("data", (chunk: Buffer) => {
      if (rejected) return
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

      for (;;) {
        const newlineIndex = buffer.indexOf(0x0a)
        if (newlineIndex === -1) {
          if (buffer.length > MAX_LINE_BYTES) {
            rejected = true
            buffer = Buffer.alloc(0)
            sendLine(socket, {
              id: "unknown",
              ok: false,
              error: `Request line exceeds ${MAX_LINE_BYTES} byte limit`,
              code: "REQUEST_TOO_LARGE",
            })
            socket.end()
          }
          return
        }

        const lineBuf = buffer.subarray(0, newlineIndex)
        buffer = buffer.subarray(newlineIndex + 1)

        if (lineBuf.length > MAX_LINE_BYTES) {
          rejected = true
          buffer = Buffer.alloc(0)
          sendLine(socket, {
            id: "unknown",
            ok: false,
            error: `Request line exceeds ${MAX_LINE_BYTES} byte limit`,
            code: "REQUEST_TOO_LARGE",
          })
          socket.end()
          return
        }

        const line = lineBuf.toString("utf8").trim()
        if (!line) continue

        pending += 1
        void dispatchAdminLine(line, handlers)
          .then((response) => sendLine(socket, response))
          .finally(() => {
            pending -= 1
            maybeFinishHalfOpen()
          })
      }
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      rejectListen(error)
    }
    server.once("error", onError)
    server.listen(endpoint, () => {
      server.removeListener("error", onError)
      if (process.platform !== "win32") {
        try {
          chmodSync(endpoint, 0o600)
        } catch (error) {
          server.close(() => {
            removePosixEndpointIfNeeded(endpoint)
            rejectListen(error)
          })
          return
        }
      }
      resolveListen()
    })
  })

  // listen 成功后保留错误兜底，防止后续异步错误成为未捕获异常。
  server.on("error", () => {})

  let closing: Promise<void> | undefined
  return {
    endpoint,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolveClose) => {
        for (const client of clients) client.destroy()
        server.close(() => {
          removePosixEndpointIfNeeded(endpoint)
          resolveClose()
        })
      })
      return closing
    },
  }
}

/** 向运行中的 Host 控制通道发送单次请求并等待对应响应。 */
export function callAdminSocket<M extends HostAdminMethod>(
  endpoint: string,
  method: M,
  params: HostAdminParams<M>,
  timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<HostAdminResultMap[M]> {
  const id = randomUUID()
  return new Promise((resolveCall, rejectCall) => {
    let settled = false
    let buffer: Buffer = Buffer.alloc(0)
    const socket = createConnection(endpoint)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
    }

    const succeed = (value: HostAdminResultMap[M]): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveCall(value)
    }

    const fail = (error: AdminClientError): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectCall(error)
    }

    const timer = setTimeout(() => {
      fail(
        new AdminClientError(
          `Admin socket request "${method}" timed out after ${timeoutMs}ms`,
          "TIMEOUT",
        ),
      )
    }, timeoutMs)

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })

    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        const newlineIndex = buffer.indexOf(0x0a)
        if (newlineIndex === -1) return
        const line = buffer.subarray(0, newlineIndex).toString("utf8").trim()
        buffer = buffer.subarray(newlineIndex + 1)
        if (!line) continue

        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          fail(
            new AdminClientError("Malformed JSON response from admin socket", "INVALID_RESPONSE"),
          )
          return
        }
        const parsed = hostAdminResponseSchema.safeParse(raw)
        if (!parsed.success) {
          fail(
            new AdminClientError("Invalid response envelope from admin socket", "INVALID_RESPONSE"),
          )
          return
        }
        if (parsed.data.id !== id) continue
        if (parsed.data.ok) {
          succeed(parsed.data.result as HostAdminResultMap[M])
        } else {
          fail(new AdminClientError(parsed.data.error, parsed.data.code))
        }
        return
      }
    })

    socket.once("error", (error: NodeJS.ErrnoException) => {
      fail(new AdminClientError(error.message || "Admin socket connection failed", error.code))
    })

    socket.once("close", () => {
      fail(
        new AdminClientError("Admin socket closed before receiving response", "CONNECTION_CLOSED"),
      )
    })
  })
}
