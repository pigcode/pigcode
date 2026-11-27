/** 验证 `pigcode pair --desktop` 桌面端配对链接生成、验证码确认及客户端列表/撤销。 */
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runHeadlessCli } from "./headless-cli"
import {
  createCapturedIo,
  createTempDirs,
  startFixtureAdminServer,
} from "./headless-cli.test-helpers"
import { acquireHostLock } from "./host-lock"

const temps = await createTempDirs()
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
  await temps.cleanup()
})

describe("runHeadlessCli - desktop pair and revoke", () => {
  it("supports pigcode pair --desktop, lists desktop clients in devices, and revokes them", async () => {
    const profileDir = await temps.makeDir()
    const attemptId = randomUUID()
    const confirmation = randomUUID()
    let phase: "waiting" | "verify" | "paired" = "waiting"

    const confirmSpy = vi.fn(() => {
      phase = "paired"
      return { status: "paired" as const, attempt: null, clients: [] }
    })
    const revokeDesktopSpy = vi.fn(() => ({
      status: "revoked" as const,
      pairing: { status: "idle" as const, attempt: null, clients: [] },
    }))
    const desktopId = "b".repeat(64)

    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "desktop.pairing.start": () => ({
        status: "waiting",
        attempt: {
          id: attemptId,
          expiresAt: Date.now() + 60_000,
          link: "pigcode://pair?v=1&d=demo",
          lanAddresses: ["ws://192.168.1.50:39871/ws"],
          candidate: null,
        },
        clients: [],
      }),
      "desktop.pairing.view": () => {
        if (phase === "waiting") phase = "verify"
        return {
          status: phase,
          attempt:
            phase === "verify"
              ? {
                  id: attemptId,
                  expiresAt: Date.now() + 60_000,
                  link: "pigcode://pair?v=1&d=demo",
                  lanAddresses: ["ws://192.168.1.50:39871/ws"],
                  candidate: {
                    confirmation,
                    code: "731049",
                    name: "Work MacBook",
                    platform: "macos" as const,
                  },
                }
              : null,
          clients: [],
        }
      },
      "desktop.pairing.confirm": confirmSpy,
      "desktop.devices.list": () => [
        {
          id: desktopId,
          name: "Work MacBook",
          platform: "macos" as const,
          lastConnectedAt: 1_700_000_000_000,
          connected: true,
        },
      ],
      "desktop.devices.revoke": revokeDesktopSpy,
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const ioPair = createCapturedIo(true)
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair", "--desktop"], {
        ...ioPair,
        pollIntervalMs: 5,
        confirmPrompt: async () => "y",
      }),
    ).toBe(0)
    expect(ioPair.readStdout()).toContain("pigcode://pair?v=1&d=demo")
    expect(ioPair.readStdout()).toContain("731049")
    expect(confirmSpy).toHaveBeenCalledWith({ id: attemptId, confirmation })

    const ioDevices = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "devices"], ioDevices)).toBe(0)
    expect(ioDevices.readStdout()).toContain("桌面端")
    expect(ioDevices.readStdout()).toContain("Work MacBook")

    const ioRevoke = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "revoke", desktopId.slice(0, 8), "--yes"],
        ioRevoke,
      ),
    ).toBe(0)
    expect(revokeDesktopSpy).toHaveBeenCalledWith({ deviceId: desktopId })
  })
})
