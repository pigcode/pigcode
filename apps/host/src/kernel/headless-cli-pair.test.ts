/** 验证 pigcode-host CLI 的终端扫码配对、竞态中止、设备列表与撤销配对流程。 */
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MobilePairingView } from "@pigcode/contracts"
import { PairedDevices, pairedDeviceId } from "../mobile/paired-devices"
import { apply as settingsPlugin } from "../services/settings"
import { runHeadlessCli } from "./headless-cli"
import {
  createCapturedIo,
  createTempDirs,
  makePairedDevice,
  makePairingViewDevice,
  startFixtureAdminServer,
  TestSignalSource,
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

describe("runHeadlessCli - pair", () => {
  it("fails pair cleanly when host is offline or needs relay", async () => {
    const profileDir = await temps.makeDir()
    const ioOffline = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "pair"], ioOffline)).toBe(1)
    expect(ioOffline.readStderr()).toContain("Host 未运行")

    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "mobile.pairing.start": () => ({ status: "needs-relay", attempt: null, devices: [] }),
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const ioNeedsRelay = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "pair"], ioNeedsRelay)).toBe(1)
    expect(ioNeedsRelay.readStderr()).toContain("relay set")
  })

  it("renders terminal QR, polls waiting -> verify, confirms y/update, rejects n, and emits NDJSON", async () => {
    const profileDir = await temps.makeDir()
    const attemptId = randomUUID()
    const confirmation = randomUUID()
    const qrPayload = JSON.stringify({ type: "pigcode.pair", v: 1 })
    let phase: "waiting" | "verify" | "paired" | "update-approved" | "cancelled" = "waiting"
    let mode: "pair" | "update" = "pair"
    let viewCalls = 0
    const confirmSpy = vi.fn(() => {
      phase = mode === "update" ? "update-approved" : "paired"
      return { status: phase, attempt: null, devices: [] }
    })
    const cancelSpy = vi.fn(() => {
      phase = "cancelled"
      return { status: "cancelled" as const, attempt: null, devices: [] }
    })
    const buildView = (): MobilePairingView => ({
      status: phase,
      attempt:
        phase === "waiting" || phase === "verify"
          ? {
              id: attemptId,
              expiresAt: Date.now() + 60_000,
              qr: qrPayload,
              candidate:
                phase === "verify"
                  ? { confirmation, code: "482910", name: "iPhone 16", mode }
                  : null,
            }
          : null,
      devices: [],
    })

    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "mobile.pairing.start": () => {
        phase = "waiting"
        viewCalls = 0
        return buildView()
      },
      "mobile.pairing.view": () => {
        viewCalls += 1
        if (phase === "waiting" && viewCalls >= 2) phase = "verify"
        return buildView()
      },
      "mobile.pairing.confirm": confirmSpy,
      "mobile.pairing.cancel": cancelSpy,
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const ioOk = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair", "--show-raw"], {
        ...ioOk,
        pollIntervalMs: 10,
        confirmPrompt: async () => "y",
      }),
    ).toBe(0)
    expect(ioOk.readStdout()).toContain("482910")
    expect(ioOk.readStdout()).toContain("iPhone 16")
    expect(ioOk.readStdout()).toContain(qrPayload)
    expect(ioOk.readStdout()).toMatch(/[\u2580-\u259F]/)
    expect(confirmSpy).toHaveBeenCalledWith({ id: attemptId, confirmation })

    const ioReject = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair"], {
        ...ioReject,
        pollIntervalMs: 10,
        confirmPrompt: async () => "n",
      }),
    ).toBe(1)
    expect(cancelSpy).toHaveBeenCalledWith({ id: attemptId })

    mode = "update"
    const ioUpdate = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair"], {
        ...ioUpdate,
        pollIntervalMs: 10,
        confirmPrompt: async () => "yes",
      }),
    ).toBe(0)
    expect(ioUpdate.readStdout()).toContain("更新中继配置")

    mode = "pair"
    const ioJson = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair", "--json"], {
        ...ioJson,
        pollIntervalMs: 10,
        confirmPrompt: async () => "yes",
      }),
    ).toBe(0)
    const events = ioJson
      .readStdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; code?: string })
    expect(events.map((e) => e.event)).toEqual(["waiting", "verify", "paired"])
    expect(events[1]?.code).toBe("482910")
  })

  it("aborts confirmation prompt on expiry, phone disconnect, or SIGINT cancel", async () => {
    const profileDir = await temps.makeDir()
    const attemptId = randomUUID()
    const confirmation = randomUUID()
    let status: MobilePairingView["status"] = "verify"
    const cancelSpy = vi.fn(() => ({ status: "cancelled" as const, attempt: null, devices: [] }))

    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "mobile.pairing.start": () => ({
        status: "waiting",
        attempt: { id: attemptId, expiresAt: Date.now() + 60_000, qr: "{}", candidate: null },
        devices: [],
      }),
      "mobile.pairing.view": () => ({
        status,
        attempt:
          status === "verify" || status === "waiting"
            ? {
                id: attemptId,
                expiresAt: Date.now() + 60_000,
                qr: "{}",
                candidate:
                  status === "verify"
                    ? { confirmation, code: "123456", name: "Pixel", mode: "update" }
                    : null,
              }
            : null,
        devices: [],
      }),
      "mobile.pairing.cancel": cancelSpy,
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    // 真实 stdin 流在等待确认期间被后台轮询发现过期，AbortController 应立即中止等待。
    const ioExpire = createCapturedIo()
    setTimeout(() => {
      status = "expired"
    }, 35)
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair"], {
        ...ioExpire,
        pollIntervalMs: 10,
      }),
    ).toBe(1)
    expect(ioExpire.readStderr()).toContain("过期")

    // 手机在等待核对时断线回退到 waiting，同样中止等待并取消本次配对。
    status = "verify"
    const ioDisconnect = createCapturedIo()
    setTimeout(() => {
      status = "waiting"
    }, 35)
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair"], {
        ...ioDisconnect,
        pollIntervalMs: 10,
      }),
    ).toBe(1)
    expect(ioDisconnect.readStderr()).toContain("断开")
    expect(cancelSpy).toHaveBeenCalledWith({ id: attemptId })

    // 等待确认时收到 SIGINT，应取消配对并返回 130。
    status = "verify"
    const signals = new TestSignalSource()
    const ioSig = createCapturedIo()
    setTimeout(() => signals.emit("SIGINT"), 30)
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "pair"], {
        ...ioSig,
        pollIntervalMs: 10,
        signalSource: signals,
      }),
    ).toBe(130)
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })
})

describe("runHeadlessCli - devices and revoke", () => {
  it("lists devices and revokes by prefix or name (online/offline) with ambiguity & TTY checks", async () => {
    const profileDir = await temps.makeDir()
    const ioEmpty = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "devices"], ioEmpty)).toBe(0)
    expect(ioEmpty.readStdout()).toContain("还没有已配对设备")

    const d1 = makePairedDevice(1, "Work iPhone", "ios")
    const d2 = makePairedDevice(2, "Backup Pixel", "android")
    const d3 = makePairedDevice(3, "Work iPhone", "ios")
    const id1 = pairedDeviceId(d1.publicKey)
    const id2 = pairedDeviceId(d2.publicKey)

    const ctx = new Context()
    await ctx.plugin(settingsPlugin, { path: join(profileDir, "settings.json") })
    const paired = new PairedDevices(ctx.settings)
    paired.save(d1)
    paired.save(d2)
    paired.save(d3)
    await ctx.fiber.dispose()

    const ioList = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "devices"], ioList)).toBe(0)
    expect(ioList.readStdout()).toContain(id1.slice(0, 8).toUpperCase())
    expect(ioList.readStdout()).toContain("Backup Pixel")

    const ioMissing = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "revoke", "nonexistent", "--yes"],
        ioMissing,
      ),
    ).toBe(1)

    const ioAmbiguousName = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "revoke", "Work iPhone", "--yes"],
        ioAmbiguousName,
      ),
    ).toBe(1)
    expect(ioAmbiguousName.readStderr()).toContain("匹配")

    const ioNeedYes = createCapturedIo(false)
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "revoke", id2.slice(0, 8)], ioNeedYes),
    ).toBe(2)
    expect(ioNeedYes.readStderr()).toContain("--yes")

    // TTY 下交互输入 n 取消，输入 y 确认离线按 8 位编号撤销
    const ioTtyCancel = createCapturedIo(true)
    ioTtyCancel.stdin.end("n\n")
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "revoke", id2.slice(0, 8)], ioTtyCancel),
    ).toBe(1)

    const ioOfflineRevoke = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "revoke", id2.slice(0, 8).toUpperCase(), "--yes"],
        ioOfflineRevoke,
      ),
    ).toBe(0)

    const verifyCtx = new Context()
    await verifyCtx.plugin(settingsPlugin, { path: join(profileDir, "settings.json") })
    expect(new PairedDevices(verifyCtx.settings).findById(id2)).toBeUndefined()
    await verifyCtx.fiber.dispose()

    // 在线通过 admin socket 撤销
    const revokeSpy = vi.fn(({ deviceId }: { deviceId: string }) => ({
      status: "revoked" as const,
      pairing: { status: "idle" as const, attempt: null, devices: [] },
      deviceId,
    }))
    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "mobile.devices.list": () => [makePairingViewDevice(d1)],
      "mobile.devices.revoke": revokeSpy,
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const ioOnlineRevoke = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "revoke", id1.slice(0, 10), "--yes"],
        ioOnlineRevoke,
      ),
    ).toBe(0)
    expect(revokeSpy).toHaveBeenCalledWith({ deviceId: id1 })
  })
})
