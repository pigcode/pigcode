/** 验证跨桌面端（Desktop-to-Host）Noise IK 配对、全权 RpcServer 桥接、大报文分片、角色隔离与撤销授权。 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DESKTOP_RPC_MAX_BYTES,
  desktopPairingViewSchema,
  desktopProtocolVersion,
  desktopRevokeResultSchema,
  parseDesktopPairingInput,
  rpcSuccessSchema,
} from "@pigcode/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { beginNoise, noiseKeyPair } from "../mobile/noise"
import { FrameAssembler, mobileFrames } from "../mobile/mobile-frames"
import { apply as workspacePlugin } from "../services/workspace"
import { startMobileHost } from "./mobile-test-fixture"

const cleanupDirs: string[] = []

afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true })
})

interface WsMessageSession {
  ws: WebSocket
  nextBuffer: () => Promise<Buffer>
  close: () => void
}

async function openRawWs(url: string): Promise<WsMessageSession> {
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  const queue: Buffer[] = []
  const waiters: Array<(buf: Buffer) => void> = []
  let closed = false
  let err: Error | undefined

  ws.addEventListener("message", (event) => {
    const buf = Buffer.from(event.data as ArrayBuffer)
    const waiter = waiters.shift()
    if (waiter) waiter(buf)
    else queue.push(buf)
  })
  ws.addEventListener("close", () => {
    closed = true
    for (const waiter of waiters.splice(0)) waiter(Buffer.alloc(0))
  })
  ws.addEventListener("error", () => {
    err = new Error("WebSocket error")
  })

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(err ?? new Error("ws open failed")), { once: true })
  })

  return {
    ws,
    nextBuffer: () => {
      const immediate = queue.shift()
      if (immediate) return Promise.resolve(immediate)
      if (closed) return Promise.resolve(Buffer.alloc(0))
      return new Promise((resolve) => waiters.push(resolve))
    },
    close: () => ws.close(),
  }
}

async function nextDecryptedMessage(
  session: WsMessageSession,
  decrypt: (buf: Buffer) => Buffer,
  assembler: FrameAssembler,
): Promise<Record<string, unknown>> {
  while (true) {
    const raw = await session.nextBuffer()
    if (raw.length === 0) throw new Error("socket closed before complete message")
    const plain = decrypt(raw)
    const res = assembler.push(plain)
    if (res.complete) return res.message as Record<string, unknown>
  }
}

describe("desktop pairing and full RpcServer bridge", () => {
  it("pairs a remote desktop over LAN Noise IK, bridges RpcServer + large payloads, isolates mobile, and enforces revocation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pigcode-desktop-pair-"))
    cleanupDirs.push(workspace)

    const host = await startMobileHost()
    await host.ctx.plugin(workspacePlugin)
    const call = async (method: string, params: Record<string, unknown> = {}) =>
      rpcSuccessSchema.parse(await host.call(method, params)).result

    try {
      // Wait for LAN addresses and generate desktop pairing link (works without Relay too!).
      const started = desktopPairingViewSchema.parse(await call("desktop.pairing.start"))
      expect(started.status).toBe("waiting")
      expect(started.attempt?.link).toBeTruthy()
      const parsedLink = parseDesktopPairingInput(started.attempt!.link!)
      expect(parsedLink.ok).toBe(true)
      if (!parsedLink.ok) throw new Error("expected valid link")

      const lanUrl = parsedLink.payload.lanAddresses?.[0]
      expect(lanUrl).toBeTruthy()
      const hostPub = Buffer.from(parsedLink.payload.hostKey, "base64url")

      // 1. Wrong role (mobile platform/hello against desktop link) is rejected on the wire.
      const mobileFakeKey = noiseKeyPair()
      const wrongRoleWs = await openRawWs(lanUrl!)
      const wrongInit = beginNoise(
        mobileFakeKey,
        hostPub,
        Buffer.from(
          JSON.stringify({
            type: "device.pair",
            role: "mobile",
            secret: parsedLink.payload.secret,
            name: "Sneaky Mobile",
            platform: "ios",
          }),
        ),
      )
      wrongRoleWs.ws.send(wrongInit.message)
      expect((await wrongRoleWs.nextBuffer()).length).toBe(0)
      wrongRoleWs.close()

      // 2. Pair a remote desktop client using the link + verify 6-digit code.
      const clientKey = noiseKeyPair()
      const conn = await openRawWs(lanUrl!)
      const handshake = beginNoise(
        clientKey,
        hostPub,
        Buffer.from(
          JSON.stringify({
            type: "device.pair",
            role: "desktop",
            secret: parsedLink.payload.secret,
            name: "Work MacBook Pro",
            platform: "macos",
          }),
        ),
      )
      conn.ws.send(handshake.message)
      const replyBytes = await conn.nextBuffer()
      const { session: noise } = handshake.finish(replyBytes)
      const assembler = new FrameAssembler(DESKTOP_RPC_MAX_BYTES)

      for (const frame of mobileFrames({ type: "device.confirm" }, DESKTOP_RPC_MAX_BYTES)) {
        conn.ws.send(noise.encrypt(frame))
      }

      const checkMsg = await nextDecryptedMessage(conn, noise.decrypt, assembler)
      expect(checkMsg).toEqual({ type: "device.check" })

      const verifyView = desktopPairingViewSchema.parse(await call("desktop.pairing"))
      expect(verifyView.status).toBe("verify")
      expect(verifyView.attempt?.candidate).toMatchObject({
        code: noise.verificationCode,
        name: "Work MacBook Pro",
        platform: "macos",
      })

      const pairedView = desktopPairingViewSchema.parse(
        await call("desktop.pairing.confirm", {
          id: verifyView.attempt!.id,
          confirmation: verifyView.attempt!.candidate!.confirmation,
        }),
      )
      expect(pairedView.status).toBe("paired")
      expect(pairedView.clients).toHaveLength(1)
      expect(pairedView.clients[0]).toMatchObject({ name: "Work MacBook Pro", platform: "macos" })

      // Mobile view MUST NOT list desktop clients!
      const mobileView = (await call("mobile.pairing")) as { devices: unknown[] }
      expect(mobileView.devices).toEqual([])

      const approved = await nextDecryptedMessage(conn, noise.decrypt, assembler)
      expect(approved).toMatchObject({ type: "device.approved" })

      // 3. Negotiate desktop.hello -> full RpcServer bridge!
      for (const frame of mobileFrames(
        { type: "desktop.hello", minVersion: 1, maxVersion: desktopProtocolVersion },
        DESKTOP_RPC_MAX_BYTES,
      )) {
        conn.ws.send(noise.encrypt(frame))
      }
      const welcome = await nextDecryptedMessage(conn, noise.decrypt, assembler)
      expect(welcome).toMatchObject({
        type: "desktop.welcome",
        version: 1,
        hostKey: parsedLink.payload.hostKey,
      })

      const rpcCall = async (method: string, params: Record<string, unknown> = {}) => {
        const id = `req-${Math.random()}`
        for (const frame of mobileFrames(
          { jsonrpc: "2.0", id, method, params },
          DESKTOP_RPC_MAX_BYTES,
        )) {
          conn.ws.send(noise.encrypt(frame))
        }
        while (true) {
          const msg = await nextDecryptedMessage(conn, noise.decrypt, assembler)
          if (msg.id === id) return msg
        }
      }

      const renamed = await rpcCall("host.setName", { name: "Home Linux NAS" })
      expect(renamed.result).toEqual({ hostName: "Home Linux NAS" })

      const identityRes = await rpcCall("host.identity")
      expect(identityRes.result).toMatchObject({
        hostKey: parsedLink.payload.hostKey,
        hostName: "Home Linux NAS",
      })

      const browsed = await rpcCall("host.browseDirs", { path: workspace })
      expect(browsed.result).toMatchObject({ path: expect.any(String), entries: expect.any(Array) })

      const addedProject = await rpcCall("project.add", { rootPath: workspace, name: "nas-repo" })
      const projectId = (addedProject.result as { id: string }).id

      // Create and read back >120KB file (chunked across multiple 64KB Noise frames!).
      const bigText = "line-of-code-1234567890\n".repeat(6000)
      expect(bigText.length).toBeGreaterThan(120_000)
      const createRes = await rpcCall("workspace.createFile", {
        projectId,
        path: "big-file.txt",
        text: bigText,
      })
      expect(createRes.error).toBeUndefined()
      const readRes = await rpcCall("workspace.readFile", {
        projectId,
        path: "big-file.txt",
        encoding: "text",
      })
      expect(readRes.error).toBeUndefined()
      expect(
        (readRes.result as { content?: string; text?: string }).content ??
          (readRes.result as { text?: string }).text,
      ).toBe(bigText)

      // 4. Revoking the desktop client immediately notifies device.revoked and disconnects.
      const revokeRes = desktopRevokeResultSchema.parse(
        await call("desktop.devices.revoke", { deviceId: pairedView.clients[0]!.id }),
      )
      expect(revokeRes.status).toBe("revoked")
      expect(revokeRes.pairing.clients).toEqual([])

      const revokedNotice = await nextDecryptedMessage(conn, noise.decrypt, assembler)
      expect(revokedNotice).toEqual({ type: "device.revoked" })
      conn.close()

      // Subsequent reconnect with revoked clientKey receives device.revoked refusal.
      const retryConn = await openRawWs(lanUrl!)
      const retryHandshake = beginNoise(
        clientKey,
        hostPub,
        Buffer.from(JSON.stringify({ type: "device.connect", revocationNotice: true })),
      )
      retryConn.ws.send(retryHandshake.message)
      const denial = retryHandshake.finish(await retryConn.nextBuffer())
      expect(JSON.parse(denial.payload.toString("utf8"))).toEqual({ type: "device.revoked" })
      retryConn.close()
    } finally {
      await host.stop()
    }
  })
})
