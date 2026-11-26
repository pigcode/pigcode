import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { discoverLanUrls, openLanServer } from "./lan-server"
import { beginNoise, noiseKeyPair } from "./noise"
import { PairedDevices } from "./paired-devices"

describe("mobile LAN direct server", () => {
  it("discovers RFC1918/CGNAT private IPv4 addresses cleanly", () => {
    const urls = discoverLanUrls(39871)
    for (const url of urls) {
      expect(url).toMatch(/^ws:\/\/\d+\.\d+\.\d+\.\d+:39871\/ws$/)
      expect(url).not.toContain("127.0.0.1")
      expect(url).not.toContain("169.254.")
    }
    expect(discoverLanUrls(0)).toEqual([])
  })

  it("handles RFC6455 binary frames, fragmentation, and ping/pong over localhost", async () => {
    const received: Buffer[] = []
    let closedCount = 0
    const server = await openLanServer({
      onConnection: (conn) => ({
        onMessage: (payload) => {
          received.push(payload)
          conn.send(Buffer.concat([Buffer.from("echo:"), payload]))
        },
        onClose: () => {
          closedCount += 1
        },
      }),
    })
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
      ws.binaryType = "arraybuffer"
      const replies: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          ws.send(Buffer.from("hello-lan"))
          ws.send(Buffer.alloc(300, 0x41))
        })
        ws.addEventListener("message", ({ data }) => {
          replies.push(Buffer.from(data as ArrayBuffer))
          if (replies.length === 2) resolve()
        })
        ws.addEventListener("error", () => reject(new Error("ws error")))
      })

      expect(received[0]!.toString("utf8")).toBe("hello-lan")
      expect(received[1]!).toHaveLength(300)
      expect(replies[0]!.toString("utf8")).toBe("echo:hello-lan")
      expect(replies[1]!.subarray(0, 5).toString("utf8")).toBe("echo:")
      expect(replies[1]!).toHaveLength(305)
      ws.close()
      await new Promise((r) => setTimeout(r, 30))
      expect(closedCount).toBe(1)
    } finally {
      server.close()
    }
  })

  it("authenticates paired devices via Noise IK over LAN and refuses unpaired devices or QR pairing", async () => {
    const pairedKeys = noiseKeyPair(randomBytes(32))
    const host = await startMobileHost()
    const mobile = host.ctx.get("mobileConnections")!

    try {
      await mobile.readyLanAddresses()
      const identity = (await (mobile as unknown as { computerIdentity(): Promise<{ publicKey: Buffer; privateKey: Buffer }> }).computerIdentity())
      const port = (mobile as unknown as { lanServer: { port: number } }).lanServer.port

      // 1. 配对过的设备可直连完成 Noise IK 握手并收到 mobile.welcome
      ;(mobile as unknown as { devices: PairedDevices }).devices.save({
        publicKey: pairedKeys.publicKey.toString("base64url"),
        name: "测试 iPhone",
        platform: "ios",
        lastConnectedAt: null,
      })

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.binaryType = "arraybuffer"
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true })
        ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true })
      })

      const init = beginNoise(
        pairedKeys,
        identity.publicKey,
        Buffer.from(JSON.stringify({ type: "device.connect", revocationNotice: true })),
      )
      ws.send(init.message)

      const responseFrame = await new Promise<Buffer>((resolve) => {
        ws.addEventListener("message", ({ data }) => resolve(Buffer.from(data as ArrayBuffer)), {
          once: true,
        })
      })
      const finished = init.finish(responseFrame)
      expect(finished.payload.length).toBe(0)

      ws.send(
        finished.session.encrypt(
          Buffer.from(
            JSON.stringify({
              type: "mobile.hello",
              minVersion: 1,
              maxVersion: 1,
              features: ["connection.status", "terminal"],
            }),
          ),
        ),
      )

      const welcomeBuf = await new Promise<Buffer>((resolve) => {
        ws.addEventListener("message", ({ data }) => resolve(Buffer.from(data as ArrayBuffer)), {
          once: true,
        })
      })
      const welcome = JSON.parse(finished.session.decrypt(welcomeBuf).toString("utf8")) as {
        type: string
        features: string[]
      }
      expect(welcome.type).toBe("mobile.welcome")
      expect(welcome.features).toContain("terminal")

      // 2. 未配对设备走 LAN 会收到 device.revoked 通知并被立即断开
      const strangerKeys = noiseKeyPair(randomBytes(32))
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws2.binaryType = "arraybuffer"
      await new Promise<void>((resolve) => ws2.addEventListener("open", () => resolve(), { once: true }))
      const init2 = beginNoise(
        strangerKeys,
        identity.publicKey,
        Buffer.from(JSON.stringify({ type: "device.connect", revocationNotice: true })),
      )
      ws2.send(init2.message)
      const denyFrame = await new Promise<Buffer>((resolve) => {
        ws2.addEventListener("message", ({ data }) => resolve(Buffer.from(data as ArrayBuffer)), {
          once: true,
        })
      })
      const denied = init2.finish(denyFrame)
      expect(JSON.parse(denied.payload.toString("utf8"))).toEqual({ type: "device.revoked" })
      ws.close()
      ws2.close()
    } finally {
      await host.stop()
    }
  })
})
