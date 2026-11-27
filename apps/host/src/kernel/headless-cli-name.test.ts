/** 验证 pigcode name 子命令（离线与存活管理套接字两种路径）。 */
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

describe("runHeadlessCli - name", () => {
  it("supports pigcode name get/set both offline and live via admin socket", async () => {
    const profileDir = await temps.makeDir()
    const ioSetOffline = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "name", "home-linux-nas", "--json"],
        ioSetOffline,
      ),
    ).toBe(0)
    expect(JSON.parse(ioSetOffline.readStdout())).toMatchObject({
      running: false,
      hostName: "home-linux-nas",
    })

    const ioGetOffline = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "name"], ioGetOffline)).toBe(0)
    expect(ioGetOffline.readStdout().trim()).toBe("home-linux-nas")

    const setNameSpy = vi.fn(({ name }: { name: string }) => ({ hostName: name }))
    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "host.setName": setNameSpy,
      "host.status": () => ({
        pid: process.pid,
        runtime: "headless",
        version: "0.1.0-test",
        profileDir,
        startedAt: Date.now(),
        relay: { address: null, tokenConfigured: false },
        lanAddresses: [],
        activeRuns: 0,
        pendingApprovals: 0,
        pairedDevices: 0,
        hostName: "office-box",
      }),
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const ioGetLive = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "name"], ioGetLive)).toBe(0)
    expect(ioGetLive.readStdout().trim()).toBe("office-box")

    const ioSetLive = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "name", "studio-mac"], ioSetLive),
    ).toBe(0)
    expect(setNameSpy).toHaveBeenCalledWith({ name: "studio-mac" })
    expect(ioSetLive.readStdout()).toContain("studio-mac")
  })
})
