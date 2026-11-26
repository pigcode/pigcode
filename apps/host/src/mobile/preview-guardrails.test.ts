import {
  MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  mobileFeatures,
  mobilePreviewMethods,
  type MobilePreviewFetchResult,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { MOBILE_PREVIEW_BLOCKED_PORTS } from "../services/mobile-preview"
import { MobilePreview, validateMobilePreviewUrl } from "./preview"
import { setupPreviewHost, startLocalPreviewTestServer } from "./preview.test-helpers"

describe("mobile preview.tunnel security guardrails & limits", () => {
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

  it("enforces timeout, 16 MiB response cap, and idle stream TTL cleanup", async () => {
    const server = await startLocalPreviewTestServer()
    const host = await setupPreviewHost()
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
})
