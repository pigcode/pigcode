import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { networkInterfaces } from "node:os"

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_FRAME_BYTES = 65535
const MAX_HTTP_HEADER_BYTES = 16 * 1024

export interface LanConnection {
  send(payload: Buffer): void
  close(): void
}

export interface LanServer {
  readonly port: number
  addresses(): string[]
  close(): void
}

export interface LanServerEvents {
  onConnection(connection: LanConnection): LanConnectionHandlers
}

export interface LanConnectionHandlers {
  onMessage(payload: Buffer): void
  onClose(): void
}

function isPrivateOrCgnatIpv4(ip: string): { valid: boolean; priority: number } {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { valid: false, priority: 99 }
  }
  const [a, b] = parts as [number, number, number, number]
  // 排除 169.254.0.0/16 链路本地地址，优先标准 RFC1918 内网段，其次 100.64/10（Tailscale 等）
  if (a === 192 && b === 168) return { valid: true, priority: 0 }
  if (a === 10) return { valid: true, priority: 1 }
  if (a === 172 && b >= 16 && b <= 31) return { valid: true, priority: 2 }
  if (a === 100 && b >= 64 && b <= 127) return { valid: true, priority: 3 }
  return { valid: false, priority: 99 }
}

function isVirtualNoiseInterface(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.startsWith("awdl") ||
    lower.startsWith("llw") ||
    lower.startsWith("bridge") ||
    lower.startsWith("anpi") ||
    lower.startsWith("ap") ||
    lower.startsWith("vnic")
  )
}

function interfaceRank(name: string): number {
  const lower = name.toLowerCase()
  if (lower === "en0" || lower === "eth0" || lower === "wlan0") return 0
  if (lower.startsWith("en") || lower.startsWith("eth") || lower.startsWith("wlan")) return 1
  return 2
}

/** 收集当前本机可用的私有局域网 IPv4 地址，构造 `ws://<ip>:<port>/ws`。 */
export function discoverLanUrls(port: number): string[] {
  if (!Number.isInteger(port) || port <= 0) return []
  const interfaces = networkInterfaces()
  const candidates: Array<{ url: string; score: number }> = []
  const seen = new Set<string>()

  for (const [name, list] of Object.entries(interfaces)) {
    if (!list || isVirtualNoiseInterface(name)) continue
    const ifRank = interfaceRank(name)
    for (const entry of list) {
      if (entry.internal || entry.family !== "IPv4") continue
      const checked = isPrivateOrCgnatIpv4(entry.address)
      if (!checked.valid) continue
      const url = `ws://${entry.address}:${port}/ws`
      if (seen.has(url)) continue
      seen.add(url)
      candidates.push({ url, score: ifRank * 10 + checked.priority })
    }
  }

  candidates.sort((a, b) => a.score - b.score)
  return candidates.slice(0, 6).map((c) => c.url)
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  if (len < 126) {
    const out = Buffer.allocUnsafe(2 + len)
    out[0] = 0x80 | (opcode & 0x0f)
    out[1] = len
    payload.copy(out, 2)
    return out
  }
  const out = Buffer.allocUnsafe(4 + len)
  out[0] = 0x80 | (opcode & 0x0f)
  out[1] = 126
  out.writeUInt16BE(len, 2)
  payload.copy(out, 4)
  return out
}

function attachWebSocketSocket(
  socket: Socket,
  initialHead: Buffer,
  events: LanServerEvents,
): void {
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 15_000)

  let closed = false
  let buffer: Buffer = initialHead.length > 0 ? Buffer.from(initialHead) : Buffer.alloc(0)
  let fragmentedChunks: Buffer[] = []
  let fragmentedBytes = 0
  let inFragment = false

  const closeSocket = () => {
    if (closed) return
    closed = true
    buffer = Buffer.alloc(0)
    fragmentedChunks = []
    socket.destroy()
    handlers.onClose()
  }

  const connection: LanConnection = {
    send(payload) {
      if (closed || socket.destroyed || payload.length > MAX_FRAME_BYTES) return
      socket.write(encodeWsFrame(0x02, payload))
    },
    close() {
      if (closed) return
      closed = true
      buffer = Buffer.alloc(0)
      fragmentedChunks = []
      if (!socket.destroyed) {
        socket.end(encodeWsFrame(0x08, Buffer.alloc(0)))
        socket.destroy()
      }
      handlers.onClose()
    },
  }

  const handlers = events.onConnection(connection)

  const drainFrames = () => {
    while (!closed && buffer.length >= 2) {
      const b0 = buffer[0]!
      const b1 = buffer[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2

      if (!masked) {
        closeSocket()
        return
      }
      if (length === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buffer.length < offset + 8) return
        const bigLen = buffer.readBigUInt64BE(offset)
        if (bigLen > BigInt(MAX_FRAME_BYTES)) {
          closeSocket()
          return
        }
        length = Number(bigLen)
        offset += 8
      }

      if (length > MAX_FRAME_BYTES) {
        closeSocket()
        return
      }
      if (buffer.length < offset + 4 + length) return

      const mask = buffer.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) {
        payload[i] = buffer[offset + i]! ^ mask[i & 3]!
      }
      buffer = buffer.subarray(offset + length)

      if (opcode === 0x08) {
        connection.close()
        return
      }
      if (opcode === 0x09) {
        if (!closed && !socket.destroyed) socket.write(encodeWsFrame(0x0a, payload))
        continue
      }
      if (opcode === 0x0a) {
        continue
      }
      if (opcode === 0x02 || opcode === 0x00) {
        if (opcode === 0x02 && inFragment) {
          closeSocket()
          return
        }
        if (opcode === 0x00 && !inFragment) {
          closeSocket()
          return
        }
        fragmentedBytes += payload.length
        if (fragmentedBytes > MAX_FRAME_BYTES) {
          closeSocket()
          return
        }
        fragmentedChunks.push(payload)
        if (fin) {
          const full = fragmentedChunks.length === 1 ? fragmentedChunks[0]! : Buffer.concat(fragmentedChunks)
          fragmentedChunks = []
          fragmentedBytes = 0
          inFragment = false
          handlers.onMessage(full)
        } else {
          inFragment = true
        }
        continue
      }
      // 不支持未知控制帧或文本帧
      closeSocket()
      return
    }
  }

  socket.on("data", (chunk: Buffer) => {
    if (closed) return
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    drainFrames()
  })
  socket.on("error", closeSocket)
  socket.on("close", closeSocket)
  drainFrames()
}

function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, events: LanServerEvents): void {
  const path = (req.url ?? "").split("?")[0]
  const upgrade = req.headers.upgrade
  const key = req.headers["sec-websocket-key"]
  if (
    req.method !== "GET" ||
    path !== "/ws" ||
    typeof upgrade !== "string" ||
    upgrade.toLowerCase() !== "websocket" ||
    typeof key !== "string" ||
    key.trim().length === 0 ||
    head.length > MAX_HTTP_HEADER_BYTES
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
    socket.destroy()
    return
  }

  const accept = createHash("sha1").update(key.trim() + WS_GUID).digest("base64")
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  attachWebSocketSocket(socket, head, events)
}

function listenOnPort(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      const addr = server.address() as AddressInfo | null
      resolve(addr?.port ?? 0)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ host: "0.0.0.0", port })
  })
}

/** 启动仅监听 RFC6455 二进制帧（承载 Noise IK 端到端加密通道）的轻量局域网 WebSocket 服务。 */
export async function openLanServer(
  events: LanServerEvents,
  options?: { port?: number },
): Promise<LanServer> {
  const server = createServer((_req, res) => {
    res.writeHead(426, { Connection: "close" })
    res.end()
  })
  server.maxHeadersCount = 64
  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket as Socket, head, events)
  })

  const requestedPort = options?.port ?? 0
  let actualPort: number
  try {
    actualPort = await listenOnPort(server, requestedPort)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (requestedPort !== 0 && code === "EADDRINUSE") {
      actualPort = await listenOnPort(server, 0)
    } else {
      server.close()
      throw error
    }
  }

  const sockets = new Set<Socket>()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })

  return {
    port: actualPort,
    addresses: () => discoverLanUrls(actualPort),
    close: () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
      server.close()
    },
  }
}
