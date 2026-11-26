import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { MOBILE_PREVIEW_CHUNK_BYTES, type MobilePreviewFetchResult } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { hasDartClientEnv } from "./dart-env"
import { mobileFrames } from "./mobile-frames"
import {
  MAX_NOISE_ENCRYPTED_FRAME_BYTES,
  NOISE_TAG_BYTES,
  allocateClosedLoopbackPort,
  setupPreviewHost,
  startLocalPreviewTestServer,
} from "./preview.test-helpers"

describe.skipIf(!hasDartClientEnv())("mobile preview.tunnel Dart client end-to-end", () => {
  it("runs real Node Host + Dart pigcode_client end-to-end over preview.tunnel with strict <= 65,535-byte encrypted frames", async () => {
    const server = await startLocalPreviewTestServer()
    const closedPort = await allocateClosedLoopbackPort()
    const host = await setupPreviewHost()

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
