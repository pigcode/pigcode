/** 验证 Main RemoteHostManager：真实启动 Host MobileConnections、LAN Noise IK 配对、防自连/手机码、MessageChannel 转发 RPC 与撤销。 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"
import { encodeDesktopPairingLink, rpcSuccessSchema } from "@pigcode/contracts"
import { RpcClient } from "@pigcode/client-runtime"
import { apply as workspacePlugin } from "@pigcode/host/services/workspace"
import { mobileTestCipher, startMobileHost } from "@pigcode/host/rpc/mobile-test-fixture"
import { afterEach, describe, expect, it } from "vitest"
import { RemoteHostManager, type PortLike } from "./remote-host-manager"

const cleanupDirs: string[] = []

afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true })
})

function portToTransport(port: PortLike) {
  return {
    send: (message: unknown) => port.postMessage(message),
    onMessage: (listener: (message: unknown) => void) => {
      if (port.addEventListener) {
        const handler = (ev: { data: unknown }) => listener(ev.data)
        port.addEventListener("message", handler as (ev: MessageEvent) => void)
        port.start?.()
        return () => undefined
      }
      port.on?.("message", (dataOrEv: unknown) => {
        const payload =
          typeof dataOrEv === "object" && dataOrEv !== null && "data" in dataOrEv
            ? (dataOrEv as { data: unknown }).data
            : dataOrEv
        listener(payload)
      })
      return () => undefined
    },
    close: () => port.close(),
  }
}

describe("RemoteHostManager integration", () => {
  it("blocks self-pairing and mobile QR, pairs real remote host, bridges MessageChannel RPCs, persists across restarts, and detects revocation", async () => {
    const desktopProfile = mkdtempSync(join(tmpdir(), "pigcode-desktop-profile-"))
    const remoteRepo = mkdtempSync(join(tmpdir(), "pigcode-remote-repo-"))
    cleanupDirs.push(desktopProfile, remoteRepo)

    const remoteHost = await startMobileHost()
    await remoteHost.ctx.plugin(workspacePlugin)
    const hostCall = async (method: string, params: Record<string, unknown> = {}) =>
      rpcSuccessSchema.parse(await remoteHost.call(method, params)).result

    const deliveredPorts = new Map<string, PortLike>()
    const manager = new RemoteHostManager({
      profileDir: desktopProfile,
      cipher: mobileTestCipher,
      localName: "Liuxin MacBook",
      localPlatform: "macos",
      createChannel: () => {
        const ch = new MessageChannel()
        return { port1: ch.port1 as unknown as PortLike, port2: ch.port2 as unknown as PortLike }
      },
      onPortReady: (hostId, port) => {
        deliveredPorts.set(hostId, port)
      },
    })

    try {
      const remoteIdentity = (await hostCall("host.identity")) as {
        hostKey: string
        hostName: string
      }
      // 1. Self-pairing is blocked when hostKey matches localHostKey.
      manager.setLocalHostKey(remoteIdentity.hostKey)
      const selfAttempt = await manager.startPairing({
        link: encodeDesktopPairingLink({
          type: "pigcode.desktopPair",
          version: 1,
          address: null,
          token: null,
          lanAddresses: ["ws://127.0.0.1:39871/ws"],
          hostKey: remoteIdentity.hostKey,
          hostName: remoteIdentity.hostName,
          secret: "C".repeat(43),
          expiresAt: Date.now() + 60_000,
        }),
      })
      expect(selfAttempt).toMatchObject({ state: "failed", errorCode: "self-pairing" })
      manager.setLocalHostKey("D".repeat(43))

      // 2. Mobile QR payload is explicitly rejected.
      const mobileAttempt = await manager.startPairing({
        link: JSON.stringify({
          type: "pigcode.pair",
          version: 1,
          address: "wss://relay.example/ws/v1/connect",
          token: "tok",
          computerKey: remoteIdentity.hostKey,
          computerName: "MyMac",
          secret: "C".repeat(43),
          expiresAt: Date.now() + 60_000,
        }),
      })
      expect(mobileAttempt).toMatchObject({ state: "failed", errorCode: "mobile-only" })

      // 3. Pair against the real remote Host over LAN Noise IK.
      const started = (await hostCall("desktop.pairing.start")) as {
        attempt: { id: string; link: string }
      }
      const pairPromise = manager.startPairing({
        link: started.attempt.link,
        customName: "Home Linux NAS",
        badgeColor: "green",
      })

      // Poll remote Host until verify candidate arrives, then check matching 6-digit code & confirm.
      let candidateConfirmation = ""
      let verifyCode = ""
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const view = (await hostCall("desktop.pairing")) as {
          status: string
          attempt: { candidate: { confirmation: string; code: string } | null } | null
        }
        if (view.status === "verify" && view.attempt?.candidate) {
          candidateConfirmation = view.attempt.candidate.confirmation
          verifyCode = view.attempt.candidate.code
          break
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(candidateConfirmation).toBeTruthy()
      expect(manager.getPairingState()).toMatchObject({
        state: "verify",
        verificationCode: verifyCode,
      })

      await hostCall("desktop.pairing.confirm", {
        id: started.attempt.id,
        confirmation: candidateConfirmation,
      })
      const pairedStatus = await pairPromise
      expect(pairedStatus.state).toBe("paired")
      const hostId = pairedStatus.hostId!
      expect(hostId).toBeTruthy()

      const port = deliveredPorts.get(hostId)
      expect(port).toBeTruthy()
      const rpc = new RpcClient(portToTransport(port!))
      const created = (await rpc.call("project.add", {
        rootPath: remoteRepo,
        name: "remote-app",
      })) as {
        id: string
      }
      expect(created.id).toBeTruthy()
      expect(await rpc.call("project.list", {})).toHaveLength(1)
      rpc.close()

      // Rename, update color, set default target host, and simulate fresh app startup persistence.
      manager.renameHost(hostId, "NAS 主力机")
      manager.setBadgeColor(hostId, "amber")
      expect(manager.setDefaultTargetHostId(hostId)).toEqual({ defaultTargetHostId: hostId })
      manager.dispose()

      const reopenedPorts = new Map<string, PortLike>()
      const manager2 = new RemoteHostManager({
        profileDir: desktopProfile,
        cipher: mobileTestCipher,
        createChannel: () => {
          const ch = new MessageChannel()
          return { port1: ch.port1 as unknown as PortLike, port2: ch.port2 as unknown as PortLike }
        },
        onPortReady: (id, p) => {
          reopenedPorts.set(id, p)
        },
      })
      try {
        expect(manager2.getDefaults()).toEqual({ defaultTargetHostId: hostId })
        expect(manager2.listSummaries()[0]).toMatchObject({
          id: hostId,
          name: "NAS 主力机",
          badgeColor: "amber",
        })
        manager2.startAutoConnect()
        const connectDeadline = Date.now() + 5_000
        while (!reopenedPorts.has(hostId) && Date.now() < connectDeadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(reopenedPorts.has(hostId)).toBe(true)

        // Revoke from remote Host side -> manager detects revocation cleanly.
        const desktopView = (await hostCall("desktop.pairing")) as {
          clients: Array<{ id: string }>
        }
        await hostCall("desktop.devices.revoke", { deviceId: desktopView.clients[0]!.id })

        const revokeDeadline = Date.now() + 5_000
        while (manager2.listSummaries()[0]?.status !== "revoked" && Date.now() < revokeDeadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(manager2.listSummaries()[0]?.status).toBe("revoked")
      } finally {
        manager2.dispose()
      }
    } finally {
      manager.dispose()
      await remoteHost.stop()
    }
  })
})
