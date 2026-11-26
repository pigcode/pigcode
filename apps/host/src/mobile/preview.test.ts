import {
  MOBILE_PREVIEW_CHUNK_BYTES,
  MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  mobilePreviewMethods,
  type MobilePreviewFetchResult,
  type MobilePreviewReadBodyResult,
  type MobilePreviewStatusResult,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import {
  allocateClosedLoopbackPort,
  setupPreviewHost,
  startLocalPreviewTestServer,
} from "./preview.test-helpers"
import { revokeDeviceWork } from "./revocation"

describe("mobile preview.tunnel protocol & Host implementation", () => {
  it("handles inline HTML, JS, chunked >100 KiB streams, POST JSON echo, multiple Set-Cookie, non-followed 302 redirects, desktop toggle, controlPort sync, revocation, and legacy gating", async () => {
    const server = await startLocalPreviewTestServer()
    const closedPort = await allocateClosedLoopbackPort()
    const host = await setupPreviewHost()

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
      expect(localRedirect.headers.find((h) => h.name.toLowerCase() === "location")?.value).toBe(
        "/index.html?from=redirect",
      )

      const extRedirect = (
        await phone.call(mobilePreviewMethods.fetch, {
          requestId: "req-redir-ext",
          url: `${server.baseUrl}/redirect-external`,
          method: "GET",
        })
      ).result as MobilePreviewFetchResult
      expect(extRedirect.status).toBe(302)
      expect(extRedirect.headers.find((h) => h.name.toLowerCase() === "location")?.value).toBe(
        "http://example.com/phishing",
      )

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
})
