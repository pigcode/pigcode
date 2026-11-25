import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  MOBILE_PREVIEW_CHUNK_BYTES,
  MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  mobileFeatures,
  mobilePreviewMethods,
  type MobilePreviewReadBodyResult,
  type MobilePreviewFetchResult,
  type MobilePreviewStatusResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as attachments } from "../services/attachments"
import {
  MOBILE_PREVIEW_BLOCKED_PORTS,
  apply as mobilePreviewService,
} from "../services/mobile-preview"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobilePreview, validateMobilePreviewUrl } from "./preview"
import { revokeDeviceWork } from "./revocation"
import { MobileSidebarRpc } from "./sidebar-rpc"

const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
const NOISE_TAG_BYTES = 16

function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

interface TestServerHandle {
  baseUrl: string
  port: number
  largePayload: Buffer
  close(): Promise<void>
}

async function startLocalPreviewTestServer(): Promise<TestServerHandle> {
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

async function allocateClosedLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

interface ClientHandle {
  deviceKey: string
  wire: MemoryTransport
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

async function setupHost() {
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

  const clients: ClientHandle[] = []

  function connectDevice(name: string, keyByte: number, features: readonly string[]): ClientHandle {
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

    const handle: ClientHandle = {
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

describe("mobile preview.tunnel protocol, security guardrails, and Host implementation", () => {
  it("strictly enforces loopback-only URL and blocked-port SSRF guardrails", () => {
    expect(mobileFeatures).toContain("preview.tunnel")

    for (const allowed of [
      "http://localhost:3000",
      "http://localhost:3000/app?tab=1#top",
      "http://127.0.0.1:5173/",
      "https://[::1]:8443/dashboard",
      "http://localhost/",
      "https://127.0.0.1/",
    ]) {
      expect(() => validateMobilePreviewUrl(allowed)).not.toThrow()
    }

    const blockedUrls = [
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/",
      "http://example.com/",
      "http://localhost.evil.com/",
      "http://127.0.0.1.evil.com/",
      "http://0.0.0.0:3000/",
      "http://127.0.0.2:3000/",
      "http://2130706433:3000/",
      "http://0177.0.0.1:3000/",
      "http://0x7f000001:3000/",
      "http://127.1:3000/",
      "http://[::ffff:127.0.0.1]:3000/",
      "http://[0:0:0:0:0:0:0:1]:3000/",
      "http://user:pass@localhost:3000/",
      "http://admin@127.0.0.1:3000/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ws://localhost:3000/",
      "http://localhost:0/",
      "http://localhost:65536/",
      "http://localhost:080/",
      "http://localhost:3000/\r\nX-Injected: 1",
    ]
    for (const blocked of blockedUrls) {
      expect(() => validateMobilePreviewUrl(blocked), blocked).toThrowError(/仅允许访问电脑本机/)
    }

    for (const blockedPort of MOBILE_PREVIEW_BLOCKED_PORTS) {
      expect(() => validateMobilePreviewUrl(`http://localhost:${blockedPort}/`)).toThrowError(
        /仅允许访问电脑本机/,
      )
    }
  })

  it("handles inline HTML, JS, chunked >100 KiB streams, POST JSON echo, multiple Set-Cookie, non-followed 302 redirects, desktop toggle, controlPort sync, revocation, and legacy gating", async () => {
    const server = await startLocalPreviewTestServer()
    const closedPort = await allocateClosedLoopbackPort()
    const host = await setupHost()

    try {
      // 1. Default enabled === true and controlPort desktopUrls sync filters non-loopback & deduplicates
      const portListeners: Array<(event: unknown) => void> = []
      host.ctx.mobilePreview.attach({
        on(_event, listener) {
          portListeners.push(listener)
        },
        postMessage() {},
      })
      for (const listener of portListeners) {
        listener({
          data: {
            type: "desktop.previewUrls",
            urls: [
              `${server.baseUrl}/index.html`,
              `${server.baseUrl}/index.html`,
              "http://example.com/evil",
              "http://localhost:5432/",
              "http://localhost:5173",
            ],
          },
        })
      }

      const desktopSettings = await host.desktopCall("mobile.preview.getSettings")
      expect(desktopSettings.result).toEqual({
        enabled: true,
        desktopUrls: [`${server.baseUrl}/index.html`, "http://localhost:5173/"],
      })

      const phone = host.connectDevice("主手机", 21, ["preview.tunnel"])
      const otherPhone = host.connectDevice("另一部手机", 22, ["preview.tunnel"])
      const legacy = host.connectDevice("旧版手机", 23, ["sidebar.read", "workbench.read"])

      // Legacy client without preview.tunnel gets METHOD_NOT_AVAILABLE on all 4 methods
      for (const [method, params] of [
        [mobilePreviewMethods.status, {}],
        [
          mobilePreviewMethods.fetch,
          { requestId: "legacy-1", url: `${server.baseUrl}/index.html`, method: "GET" },
        ],
        [mobilePreviewMethods.readBody, { bodyStreamId: "s1", offset: 0 }],
        [mobilePreviewMethods.closeBody, { bodyStreamId: "s1" }],
      ] as const) {
        expect(await legacy.call(method, params)).toMatchObject({
          error: { code: "METHOD_NOT_AVAILABLE" },
        })
      }

      // Status returns enabled + synced desktopUrls
      const statusRes = await phone.call(mobilePreviewMethods.status, {})
      expect(statusRes.result).toEqual({
        enabled: true,
        desktopUrls: [`${server.baseUrl}/index.html`, "http://localhost:5173/"],
      } satisfies MobilePreviewStatusResult)

      // 2. Small HTML inline response (single call, hasMore: false)
      const htmlRes = await phone.call(mobilePreviewMethods.fetch, {
        requestId: "req-html",
        url: `${server.baseUrl}/index.html`,
        method: "GET",
        headers: {
          host: "evil.example.com",
          "accept-encoding": "gzip, br",
          connection: "keep-alive",
        },
      })
      expect(htmlRes.error).toBeUndefined()
      const html = htmlRes.result as MobilePreviewFetchResult
      expect(html.status).toBe(200)
      expect(html.hasMore).toBe(false)
      expect(html.bodyStreamId).toBeUndefined()
      expect(Buffer.from(html.bodyBase64!, "base64").toString("utf8")).toContain(
        "Pigcode Local Preview",
      )
      const htmlHeaders = new Map(html.headers.map((h) => [h.name.toLowerCase(), h.value]))
      expect(htmlHeaders.get("x-preview-host")).toBe(`127.0.0.1:${server.port}`)
      expect(htmlHeaders.get("x-accept-encoding")).toBe("identity")

      // 3. JS module
      const jsRes = await phone.call(mobilePreviewMethods.fetch, {
        requestId: "req-js",
        url: `${server.baseUrl}/app.js`,
        method: "GET",
      })
      const js = jsRes.result as MobilePreviewFetchResult
      expect(js.status).toBe(200)
      expect(Buffer.from(js.bodyBase64!, "base64").toString("utf8")).toContain("preview-v1")

      // 4. >100 KiB large asset streamed via readBody & cross-device isolated
      const largeRes = await phone.call(mobilePreviewMethods.fetch, {
        requestId: "req-large",
        url: `${server.baseUrl}/large.bin`,
        method: "GET",
      })
      expect(largeRes.error).toBeUndefined()
      const large = largeRes.result as MobilePreviewFetchResult
      expect(large.status).toBe(200)
      expect(large.hasMore).toBe(true)
      expect(large.bodyBase64).toBeUndefined()
      expect(large.bodyStreamId).toBeTruthy()
      expect(large.totalBytes).toBe(server.largePayload.length)

      // Other device cannot read or close this stream
      expect(
        await otherPhone.call(mobilePreviewMethods.readBody, {
          bodyStreamId: large.bodyStreamId!,
          offset: 0,
        }),
      ).toMatchObject({ error: { code: "PREVIEW_STREAM_NOT_FOUND" } })
      expect(
        await otherPhone.call(mobilePreviewMethods.closeBody, {
          bodyStreamId: large.bodyStreamId!,
        }),
      ).toMatchObject({ error: { code: "PREVIEW_STREAM_NOT_FOUND" } })

      // Reassemble all 32 KiB chunks byte-for-byte
      const pieces: Buffer[] = []
      let offset = 0
      let chunks = 0
      for (;;) {
        chunks += 1
        const chunkRes = await phone.call(mobilePreviewMethods.readBody, {
          bodyStreamId: large.bodyStreamId!,
          offset,
          length: MOBILE_PREVIEW_CHUNK_BYTES,
        })
        expect(chunkRes.error).toBeUndefined()
        const chunk = chunkRes.result as MobilePreviewReadBodyResult
        const decoded = Buffer.from(chunk.dataBase64, "base64")
        expect(decoded.length).toBeLessThanOrEqual(MOBILE_PREVIEW_CHUNK_BYTES)
        pieces.push(decoded)
        if (chunk.nextOffset === undefined) break
        offset = chunk.nextOffset
      }
      expect(chunks).toBe(Math.ceil(server.largePayload.length / MOBILE_PREVIEW_CHUNK_BYTES))
      expect(Buffer.concat(pieces).equals(server.largePayload)).toBe(true)

      // Stream is released after EOF; subsequent readBody returns PREVIEW_STREAM_NOT_FOUND, closeBody is idempotent
      expect(
        await phone.call(mobilePreviewMethods.readBody, {
          bodyStreamId: large.bodyStreamId!,
          offset: 0,
        }),
      ).toMatchObject({ error: { code: "PREVIEW_STREAM_NOT_FOUND" } })
      expect(
        await phone.call(mobilePreviewMethods.closeBody, { bodyStreamId: large.bodyStreamId! }),
      ).toMatchObject({ result: { ok: true } })

      // 5. POST JSON echo & oversized request body rejection
      const postPayload = JSON.stringify({ action: "save", count: 42, label: "中文载荷" })
      const postRes = await phone.call(mobilePreviewMethods.fetch, {
        requestId: "req-post",
        url: `${server.baseUrl}/api/echo`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client-token": "tok_999",
          "proxy-authorization": "Basic should-be-stripped",
        },
        bodyBase64: Buffer.from(postPayload, "utf8").toString("base64"),
      })
      expect(postRes.error).toBeUndefined()
      const postResult = postRes.result as MobilePreviewFetchResult
      expect(postResult.status).toBe(201)
      expect(JSON.parse(Buffer.from(postResult.bodyBase64!, "base64").toString("utf8"))).toEqual({
        method: "POST",
        contentType: "application/json",
        customHeader: "tok_999",
        forwardedHost: `127.0.0.1:${server.port}`,
        receivedConnection: expect.any(String),
        body: { action: "save", count: 42, label: "中文载荷" },
      })

      expect(
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-too-big",
          url: `${server.baseUrl}/api/echo`,
          method: "POST",
          bodyBase64: Buffer.alloc(MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES + 1, 0x78).toString(
            "base64",
          ),
        }),
      ).toMatchObject({ error: { code: "PREVIEW_TOO_LARGE" } })

      // 6. Multiple Set-Cookie headers preserved individually
      const cookieRes = await phone.call(mobilePreviewMethods.fetch, {
        requestId: "req-cookies",
        url: `${server.baseUrl}/cookies`,
        method: "GET",
      })
      const cookieResult = cookieRes.result as MobilePreviewFetchResult
      const setCookies = cookieResult.headers
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value)
      expect(setCookies).toEqual([
        "session_id=s_12345; Path=/; HttpOnly",
        "csrf_token=c_67890; Path=/; SameSite=Lax",
        "theme=dark; Path=/",
      ])

      // 7. Redirects are NEVER followed (both local 302 and external 302 return 302 + raw Location)
      const localRedirect = (
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-redir-local",
          url: `${server.baseUrl}/redirect-local`,
          method: "GET",
        })
      ).result as MobilePreviewFetchResult
      expect(localRedirect.status).toBe(302)
      expect(
        localRedirect.headers.find((h) => h.name.toLowerCase() === "location")?.value,
      ).toBe("/index.html?from=redirect")

      const extRedirect = (
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-redir-ext",
          url: `${server.baseUrl}/redirect-external`,
          method: "GET",
        })
      ).result as MobilePreviewFetchResult
      expect(extRedirect.status).toBe(302)
      expect(
        extRedirect.headers.find((h) => h.name.toLowerCase() === "location")?.value,
      ).toBe("http://example.com/phishing")

      // 8. Unreachable port returns PREVIEW_UNREACHABLE
      expect(
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-closed-port",
          url: `http://127.0.0.1:${closedPort}/`,
          method: "GET",
        }),
      ).toMatchObject({ error: { code: "PREVIEW_UNREACHABLE" } })

      // 9. Desktop toggle disables preview immediately & re-enabling restores access
      const disabledSettings = await host.desktopCall("mobile.preview.setEnabled", {
        enabled: false,
      })
      expect(disabledSettings.result).toMatchObject({ enabled: false })
      expect(
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-disabled",
          url: `${server.baseUrl}/index.html`,
          method: "GET",
        }),
      ).toMatchObject({ error: { code: "PREVIEW_DISABLED" } })
      expect(await phone.call(mobilePreviewMethods.status, {})).toMatchObject({
        result: { enabled: false },
      })

      await host.desktopCall("mobile.preview.setEnabled", { enabled: true })
      const restored = await phone.call(mobilePreviewMethods.fetch, {
        requestId: "req-restored",
        url: `${server.baseUrl}/index.html`,
        method: "GET",
      })
      expect(restored.error).toBeUndefined()
      expect((restored.result as MobilePreviewFetchResult).status).toBe(200)

      // 10. Disconnect cleanup releases open streams
      const streamBeforeStop = (
        await otherPhone.call(mobilePreviewMethods.fetch, {
          requestId: "req-before-stop",
          url: `${server.baseUrl}/large.bin`,
          method: "GET",
        })
      ).result as MobilePreviewFetchResult
      const stoppedStreamId = streamBeforeStop.bodyStreamId!
      otherPhone.stop()
      const otherPhoneReconnected = host.connectDevice("另一部手机", 22, ["preview.tunnel"])
      expect(
        await otherPhoneReconnected.call(mobilePreviewMethods.readBody, {
          bodyStreamId: stoppedStreamId,
          offset: 0,
        }),
      ).toMatchObject({ error: { code: "PREVIEW_STREAM_NOT_FOUND" } })

      // 11. Revocation cleanup clears active streams & aborts in-flight requests
      const streamBeforeRevoke = (
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-before-revoke",
          url: `${server.baseUrl}/large.bin`,
          method: "GET",
        })
      ).result as MobilePreviewFetchResult
      const revokedStreamId = streamBeforeRevoke.bodyStreamId!
      revokeDeviceWork(host.ctx, phone.deviceKey)
      expect(
        await phone.call(mobilePreviewMethods.readBody, {
          bodyStreamId: revokedStreamId,
          offset: 0,
        }),
      ).toMatchObject({ error: { code: "PREVIEW_STREAM_NOT_FOUND" } })
    } finally {
      await host.dispose()
      await server.close()
    }
  })

  it("enforces timeout, 16 MiB response cap, and idle stream TTL cleanup", async () => {
    const server = await startLocalPreviewTestServer()
    const host = await setupHost()
    try {
      const deviceKey = Buffer.alloc(32, 31).toString("base64url")
      const preview = new MobilePreview(host.ctx, deviceKey, () => {}, {
        timeoutMs: 80,
        streamIdleTtlMs: 60,
      })

      // Timeout returns PREVIEW_TIMEOUT
      await expect(
        preview.dispatch({
          jsonrpc: "2.0",
          id: "t1",
          method: mobilePreviewMethods.fetch,
          params: {
            requestId: "req-slow",
            url: `${server.baseUrl}/slow`,
            method: "GET",
          },
        }),
      ).rejects.toMatchObject({ code: "PREVIEW_TIMEOUT" })

      // Idle TTL automatically expires unconsumed stream
      const large = (await preview.dispatch({
        jsonrpc: "2.0",
        id: "t2",
        method: mobilePreviewMethods.fetch,
        params: {
          requestId: "req-ttl",
          url: `${server.baseUrl}/large.bin`,
          method: "GET",
        },
      })) as MobilePreviewFetchResult
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(() =>
        preview.dispatch({
          jsonrpc: "2.0",
          id: "t3",
          method: mobilePreviewMethods.readBody,
          params: { bodyStreamId: large.bodyStreamId!, offset: 0 },
        }),
      ).toThrowError(/预览数据流已过期或关闭/)

      // Response > 16 MiB aborts streaming and throws PREVIEW_TOO_LARGE
      const hugePreview = new MobilePreview(host.ctx, deviceKey, () => {}, {
        fetchImpl: async () => {
          const chunk = new Uint8Array(1024 * 1024)
          let sent = 0
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent > MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES) {
                controller.close()
                return
              }
              sent += chunk.byteLength
              controller.enqueue(chunk)
            },
          })
          return new Response(stream, { status: 200, statusText: "OK" })
        },
      })

      await expect(
        hugePreview.dispatch({
          jsonrpc: "2.0",
          id: "t4",
          method: mobilePreviewMethods.fetch,
          params: {
            requestId: "req-huge",
            url: "http://127.0.0.1:3000/huge",
            method: "GET",
          },
        }),
      ).rejects.toMatchObject({ code: "PREVIEW_TOO_LARGE" })

      preview.close()
      hugePreview.close()
    } finally {
      await host.dispose()
      await server.close()
    }
  })

  it("runs real Node Host + Dart pigcode_client end-to-end over preview.tunnel with strict <= 65,535-byte encrypted frames", async () => {
    const server = await startLocalPreviewTestServer()
    const closedPort = await allocateClosedLoopbackPort()
    const host = await setupHost()

    host.ctx.mobilePreview.setDesktopUrls([`${server.baseUrl}/index.html`])
    const phone = host.connectDevice("Dart 预览手机", 77, ["preview.tunnel"])

    const clientPkgDir = fileURLToPath(
      new URL("../../../mobile/packages/pigcode_client", import.meta.url),
    )
    const dart = spawn("dart", ["run", "test/preview_e2e_driver.dart"], {
      cwd: clientPkgDir,
      stdio: ["pipe", "pipe", "pipe"],
    })
    dart.stdin.on("error", () => {})
    let stderr = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    const cmdWaiters = new Map<
      string,
      (res: { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string }) => void
    >()
    let maxOutboundEncryptedBytes = 0
    let maxInboundEncryptedBytes = 0
    let maxFrameCount = 0

    phone.wire.client.onMessage((message) => {
      const record = message as { id?: string; result?: unknown; error?: unknown }
      if (!record.id) return
      const frames = [...mobileFrames(message)]
      maxFrameCount = Math.max(maxFrameCount, frames.length)
      for (const frame of frames) {
        maxInboundEncryptedBytes = Math.max(
          maxInboundEncryptedBytes,
          frame.length + NOISE_TAG_BYTES,
        )
      }
      dart.stdin.write(
        JSON.stringify({
          dir: "rpc_res",
          id: record.id,
          ...(record.error !== undefined ? { error: record.error } : { result: record.result }),
        }) + "\n",
      )
    })

    const rl = createInterface({ input: dart.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      const msg = JSON.parse(line) as {
        dir: string
        id?: string
        method?: string
        params?: Record<string, unknown>
        cmdId?: string
        ok?: boolean
        data?: Record<string, unknown>
        error?: string
        code?: string
      }
      if (msg.dir === "rpc_req") {
        const req = {
          jsonrpc: "2.0",
          id: msg.id!,
          method: msg.method!,
          params: msg.params ?? {},
        }
        const frames = [...mobileFrames(req)]
        maxFrameCount = Math.max(maxFrameCount, frames.length)
        for (const frame of frames) {
          maxOutboundEncryptedBytes = Math.max(
            maxOutboundEncryptedBytes,
            frame.length + NOISE_TAG_BYTES,
          )
        }
        phone.wire.client.send(req)
      } else if (msg.dir === "cmd_res" && msg.cmdId) {
        const resolve = cmdWaiters.get(msg.cmdId)
        if (resolve) {
          cmdWaiters.delete(msg.cmdId)
          resolve({
            ok: msg.ok === true,
            ...(msg.data !== undefined ? { data: msg.data } : {}),
            ...(msg.error !== undefined ? { error: msg.error } : {}),
            ...(msg.code !== undefined ? { code: msg.code } : {}),
          })
        }
      }
    })

    function dartCmd(action: string, args: Record<string, unknown> = {}) {
      const cmdId = randomUUID()
      return new Promise<{
        ok: boolean
        data?: Record<string, unknown>
        error?: string
        code?: string
      }>((resolve, reject) => {
        const onExit = (code: number | null) => {
          cmdWaiters.delete(cmdId)
          reject(new Error(`Dart driver exited (${code}): ${stderr}`))
        }
        dart.once("exit", onExit)
        cmdWaiters.set(cmdId, (res) => {
          dart.off("exit", onExit)
          resolve(res)
        })
        dart.stdin.write(JSON.stringify({ dir: "cmd", cmdId, action, args }) + "\n")
      })
    }

    try {
      // 1. Status
      const statusRes = await dartCmd("getStatus")
      expect(statusRes.ok, statusRes.error).toBe(true)
      expect(statusRes.data!.status).toEqual({
        enabled: true,
        desktopUrls: [`${server.baseUrl}/index.html`],
      })

      // 2. HTML inline single response
      const htmlRes = await dartCmd("fetchAndReadAll", { url: `${server.baseUrl}/index.html` })
      expect(htmlRes.ok, htmlRes.error).toBe(true)
      expect((htmlRes.data!.response as MobilePreviewFetchResult).hasMore).toBe(false)
      expect(htmlRes.data!.chunkCount).toBe(0)
      expect(Buffer.from(htmlRes.data!.bodyBase64 as string, "base64").toString("utf8")).toContain(
        "Pigcode Local Preview",
      )

      // 3. >100 KiB streamed asset reassembled identically via Dart streamBody
      const largeRes = await dartCmd("fetchAndReadAll", { url: `${server.baseUrl}/large.bin` })
      expect(largeRes.ok, largeRes.error).toBe(true)
      expect((largeRes.data!.response as MobilePreviewFetchResult).hasMore).toBe(true)
      expect(largeRes.data!.chunkCount).toBe(
        Math.ceil(server.largePayload.length / MOBILE_PREVIEW_CHUNK_BYTES),
      )
      expect(
        Buffer.from(largeRes.data!.bodyBase64 as string, "base64").equals(server.largePayload),
      ).toBe(true)

      // 4. POST JSON echo
      const payload = JSON.stringify({ hello: "dart-e2e", num: 7 })
      const postRes = await dartCmd("fetchAndReadAll", {
        url: `${server.baseUrl}/api/echo`,
        method: "POST",
        headers: { "content-type": "application/json", "x-client-token": "dart-tok" },
        bodyBase64: Buffer.from(payload, "utf8").toString("base64"),
      })
      expect(postRes.ok, postRes.error).toBe(true)
      expect((postRes.data!.response as MobilePreviewFetchResult).status).toBe(201)
      expect(
        JSON.parse(Buffer.from(postRes.data!.bodyBase64 as string, "base64").toString("utf8")),
      ).toMatchObject({
        method: "POST",
        customHeader: "dart-tok",
        body: { hello: "dart-e2e", num: 7 },
      })

      // 5. Multiple Set-Cookie preserved
      const cookieRes = await dartCmd("fetch", { url: `${server.baseUrl}/cookies` })
      expect(cookieRes.ok, cookieRes.error).toBe(true)
      const cookies = (cookieRes.data!.response as MobilePreviewFetchResult).headers
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value)
      expect(cookies).toEqual([
        "session_id=s_12345; Path=/; HttpOnly",
        "csrf_token=c_67890; Path=/; SameSite=Lax",
        "theme=dark; Path=/",
      ])

      // 6. Local & external 302 redirects not followed
      const localRedir = await dartCmd("fetch", { url: `${server.baseUrl}/redirect-local` })
      expect(localRedir.ok, localRedir.error).toBe(true)
      expect((localRedir.data!.response as MobilePreviewFetchResult).status).toBe(302)
      expect(
        (localRedir.data!.response as MobilePreviewFetchResult).headers.find(
          (h) => h.name.toLowerCase() === "location",
        )?.value,
      ).toBe("/index.html?from=redirect")

      const extRedir = await dartCmd("fetch", { url: `${server.baseUrl}/redirect-external` })
      expect(extRedir.ok, extRedir.error).toBe(true)
      expect((extRedir.data!.response as MobilePreviewFetchResult).status).toBe(302)
      expect(
        (extRedir.data!.response as MobilePreviewFetchResult).headers.find(
          (h) => h.name.toLowerCase() === "location",
        )?.value,
      ).toBe("http://example.com/phishing")

      // 7. SSRF / blocked URLs rejected with PREVIEW_URL_NOT_ALLOWED
      for (const malicious of [
        "http://169.254.169.254/latest/meta-data",
        "http://192.168.1.1/",
        "http://example.com/",
        "http://localhost:22/",
        "http://localhost:5432/",
        "http://localhost:6379/",
        "file:///etc/passwd",
      ]) {
        const res = await dartCmd("fetch", { url: malicious })
        expect(res.ok, malicious).toBe(false)
        expect(res.code, malicious).toBe("PREVIEW_URL_NOT_ALLOWED")
      }

      // 8. Unreachable port returns PREVIEW_UNREACHABLE
      const unreachable = await dartCmd("fetch", { url: `http://127.0.0.1:${closedPort}/` })
      expect(unreachable.ok).toBe(false)
      expect(unreachable.code).toBe("PREVIEW_UNREACHABLE")

      // 9. Desktop toggle disables immediately & re-enabling recovers
      await host.desktopCall("mobile.preview.setEnabled", { enabled: false })
      const disabledFetch = await dartCmd("fetch", { url: `${server.baseUrl}/index.html` })
      expect(disabledFetch.ok).toBe(false)
      expect(disabledFetch.code).toBe("PREVIEW_DISABLED")

      await host.desktopCall("mobile.preview.setEnabled", { enabled: true })
      const reenabledFetch = await dartCmd("fetch", { url: `${server.baseUrl}/index.html` })
      expect(reenabledFetch.ok, reenabledFetch.error).toBe(true)
      expect((reenabledFetch.data!.response as MobilePreviewFetchResult).status).toBe(200)

      // 10. Every encrypted frame strictly <= 65,535 bytes and single-frame
      expect(maxFrameCount).toBe(1)
      expect(maxOutboundEncryptedBytes).toBeGreaterThan(0)
      expect(maxOutboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
      expect(maxInboundEncryptedBytes).toBeGreaterThan(0)
      expect(maxInboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
    } finally {
      if (!dart.stdin.destroyed && dart.exitCode === null) {
        dart.stdin.write(JSON.stringify({ dir: "exit" }) + "\n")
        dart.stdin.end()
      }
      rl.close()
      dart.kill()
      await host.dispose()
      await server.close()
    }
  }, 30_000)
})
