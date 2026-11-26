import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Context } from "cordis"
import { expect } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as attachments } from "../services/attachments"
import { apply as mobilePreviewService } from "../services/mobile-preview"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

export const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
export const NOISE_TAG_BYTES = 16

export function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

export interface TestServerHandle {
  baseUrl: string
  port: number
  largePayload: Buffer
  close(): Promise<void>
}

export async function startLocalPreviewTestServer(): Promise<TestServerHandle> {
  const largePayload = Buffer.alloc(128 * 1024 + 543)
  for (let i = 0; i < largePayload.length; i += 1) {
    largePayload[i] = (i * 31 + 17) & 0xff
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/"
    if (path === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Preview-Host": String(req.headers.host ?? ""),
        "X-Accept-Encoding": String(req.headers["accept-encoding"] ?? ""),
      })
      res.end("<!doctype html><html><body><h1>Pigcode Local Preview</h1></body></html>")
      return
    }
    if (path === "/app.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" })
      res.end("export const version = 'preview-v1';\n")
      return
    }
    if (path === "/large.bin") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(largePayload.length),
      })
      res.end(largePayload)
      return
    }
    if (path === "/api/echo" && req.method === "POST") {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8")
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" })
        res.end(
          JSON.stringify({
            method: req.method,
            contentType: req.headers["content-type"] ?? null,
            customHeader: req.headers["x-client-token"] ?? null,
            forwardedHost: req.headers.host ?? null,
            receivedConnection: req.headers.connection ?? null,
            body: JSON.parse(raw),
          }),
        )
      })
      return
    }
    if (path === "/cookies") {
      res.setHeader("Set-Cookie", [
        "session_id=s_12345; Path=/; HttpOnly",
        "csrf_token=c_67890; Path=/; SameSite=Lax",
        "theme=dark; Path=/",
      ])
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("cookies-ok")
      return
    }
    if (path === "/redirect-local") {
      res.writeHead(302, { Location: "/index.html?from=redirect" })
      res.end()
      return
    }
    if (path === "/redirect-external") {
      res.writeHead(302, { Location: "http://example.com/phishing" })
      res.end()
      return
    }
    if (path === "/slow") {
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "text/plain" })
          res.end("eventually")
        }
      }, 5000)
      req.on("close", () => clearTimeout(timer))
      return
    }
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not-found")
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    largePayload,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

export async function allocateClosedLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  )
  return port
}

export interface PreviewClientHandle {
  deviceKey: string
  wire: MemoryTransport
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

export async function setupPreviewHost() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(attachments)
  await ctx.plugin(settings, {})
  await ctx.plugin(mobilePreviewService)
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  const feed = new ThreadFeed(ctx)
  const devices = new PairedDevices(ctx.settings)
  const desktopWire = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  const rpcServer = new RpcServer(ctx, desktopWire.host, feed)
  rpcServer.start()

  const clients: PreviewClientHandle[] = []

  function connectDevice(
    name: string,
    keyByte: number,
    features: readonly string[],
  ): PreviewClientHandle {
    const deviceKey = Buffer.alloc(32, keyByte).toString("base64url")
    if (!devices.find(deviceKey)) {
      devices.save({ publicKey: deviceKey, name, platform: "ios", lastConnectedAt: 1000 })
    }
    const wire = new MemoryTransport()
    const replies = new Map<string, (message: unknown) => void>()
    wire.client.onMessage((message) => {
      const record = message as { id?: string }
      if (record.id && replies.has(record.id)) {
        const resolve = replies.get(record.id)!
        replies.delete(record.id)
        resolve(message)
      }
    })
    const mobile = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
      computerKey: Buffer.alloc(32, 1),
      computerName: "测试电脑",
      deviceKey,
      features,
      relayRevision: () => undefined,
    })
    mobile.start()

    const handle: PreviewClientHandle = {
      deviceKey,
      wire,
      async call(method: string, params: Record<string, unknown> = {}) {
        const id = randomUUID()
        const request = { jsonrpc: "2.0", id, method, params }
        assertSingleNoiseFrame(request)
        const replyPromise = new Promise<unknown>((resolve) => replies.set(id, resolve))
        wire.client.send(request)
        const reply = (await replyPromise) as {
          id: string
          result?: unknown
          error?: { code: string; message: string }
        }
        assertSingleNoiseFrame(reply)
        return reply
      },
      stop() {
        mobile.stop()
      },
    }
    clients.push(handle)
    return handle
  }

  async function desktopCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    desktopWire.client.send({ jsonrpc: "2.0", id, method, params })
    const reply = (await desktopWire.client.next()) as {
      id: string
      result?: unknown
      error?: { code: string; message: string }
    }
    expect(reply.id).toBe(id)
    return reply
  }

  return {
    ctx,
    devices,
    connectDevice,
    desktopCall,
    async dispose() {
      for (const client of clients) client.stop()
      rpcServer.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}
