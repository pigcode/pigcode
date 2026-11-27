/** 验证 pigcode-host CLI：全局参数、--dump-config、start 常驻与信号、status 与 relay。 */
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MobileConnections } from "../mobile/connections"
import { PairedDevices } from "../mobile/paired-devices"
import { createLocalCredentialCipher } from "../services/local-credential"
import { RelaySettings } from "../services/relay-settings"
import { apply as settingsPlugin } from "../services/settings"
import { callAdminSocket } from "./admin-socket"
import { runHeadlessCli } from "./headless-cli"
import {
  createCapturedIo,
  createTempDirs,
  makePairedDevice,
  startFixtureAdminServer,
  TestSignalSource,
  writeMinimalRuntimeProfile,
} from "./headless-cli.test-helpers"
import { acquireHostLock, probeLiveHost } from "./host-lock"

const temps = await createTempDirs()
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
  await temps.cleanup()
})

describe("runHeadlessCli - parsing, help, and --dump-config", () => {
  it("supports --help/-h and rejects unknown flags, missing values, or missing command with exit 2", async () => {
    const io1 = createCapturedIo()
    expect(await runHeadlessCli(["--help"], io1)).toBe(0)
    expect(io1.readStdout()).toContain("--dump-config")
    expect(io1.readStdout()).toContain("pair")

    const io2 = createCapturedIo()
    expect(await runHeadlessCli(["-h"], io2)).toBe(0)
    expect(io2.readStdout()).toContain("pigcode-host")

    const ioMissingCmd = createCapturedIo()
    expect(await runHeadlessCli([], ioMissingCmd)).toBe(2)
    expect(ioMissingCmd.readStderr()).toContain("--dump-config")

    const ioUnknown = createCapturedIo()
    expect(await runHeadlessCli(["status", "--unknown-flag"], ioUnknown)).toBe(2)

    const ioWrongCmdFlag = createCapturedIo()
    expect(await runHeadlessCli(["status", "--show-raw"], ioWrongCmdFlag)).toBe(2)

    const ioMissingVal = createCapturedIo()
    expect(await runHeadlessCli(["--profile"], ioMissingVal)).toBe(2)

    const ioBadPort = createCapturedIo()
    expect(await runHeadlessCli(["start", "--lan-port", "70000"], ioBadPort)).toBe(2)

    const ioNegPort = createCapturedIo()
    expect(await runHeadlessCli(["start", "--lan-port", "-1"], ioNegPort)).toBe(2)
  })

  it("dumps profile config JSON for --dump-config with --profile-dir and --profile", async () => {
    const dir = await temps.makeDir()
    await writeFile(join(dir, "fixture-plugin.mjs"), "export function apply() {}\n")
    await writeFile(
      join(dir, "custom.yml"),
      ["plugins:", "  - id: core.sample", "    name: ./fixture-plugin.mjs"].join("\n"),
    )

    const io = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", dir, "--profile", "custom", "--dump-config"], io),
    ).toBe(0)
    const dumped = JSON.parse(io.readStdout()) as { entries: Array<{ id: string }> }
    expect(dumped.entries.map((entry) => entry.id)).toEqual(["core.sample"])
  })
})

describe("runHeadlessCli - start and status", () => {
  it("starts headless host, applies shell env unless --no-shell-env, handles SIGINT and second forceExit", async () => {
    const root = await temps.makeDir()
    const profileDir = join(root, "profile")
    const runtimeRoot = join(root, "runtime")
    await writeMinimalRuntimeProfile(runtimeRoot)

    const signals = new TestSignalSource()
    const forceExit = vi.fn()
    const applyShellEnv = vi.fn(async () => undefined)
    const io = createCapturedIo()
    const env: NodeJS.ProcessEnv = { PIGCODE_CORE_PROFILE_DIR: runtimeRoot, PATH: "/usr/bin" }

    const startPromise = runHeadlessCli(
      ["--profile-dir", profileDir, "start", "--lan-port", "off", "--json"],
      {
        ...io,
        env,
        signalSource: signals,
        forceExit,
        applyLoginShellEnv: applyShellEnv,
      },
    )

    await vi.waitFor(() => expect(io.readStdout()).toContain('"event":"started"'))
    expect(applyShellEnv).toHaveBeenCalledTimes(1)
    expect(env.PATH).toContain("/usr/local/bin")

    const startedLine = JSON.parse(io.readStdout().trim()) as {
      event: string
      profileDir: string
      pid: number
      socketPath: string
      lanAddresses: string[]
    }
    expect(startedLine.profileDir).toBe(resolve(profileDir))
    expect(startedLine.pid).toBe(process.pid)
    expect(startedLine.lanAddresses).toEqual([])
    expect(await probeLiveHost(profileDir)).not.toBeNull()

    signals.emit("SIGINT")
    signals.emit("SIGINT")
    expect(forceExit).toHaveBeenCalledWith(130)
    expect(await startPromise).toBe(0)
    expect(await probeLiveHost(profileDir)).toBeNull()
    expect(signals.listenerCount("SIGINT")).toBe(0)
    expect(signals.listenerCount("SIGTERM")).toBe(0)
  })

  it("skips login shell env when --no-shell-env is set and supports SIGTERM and host.stop", async () => {
    const root = await temps.makeDir()
    const profileDir = join(root, "profile")
    const runtimeRoot = join(root, "runtime")
    await writeMinimalRuntimeProfile(runtimeRoot)

    const signals = new TestSignalSource()
    const applyShellEnv = vi.fn(async () => undefined)
    const io = createCapturedIo()
    const startPromise = runHeadlessCli(
      ["--profile-dir", profileDir, "start", "--lan-port", "0", "--no-shell-env"],
      {
        ...io,
        env: { PIGCODE_CORE_PROFILE_DIR: runtimeRoot, PATH: "/usr/bin" },
        signalSource: signals,
        applyLoginShellEnv: applyShellEnv,
      },
    )

    await vi.waitFor(() => expect(io.readStdout()).toContain("Pigcode Host 已启动"))
    expect(applyShellEnv).not.toHaveBeenCalled()

    const live = await probeLiveHost(profileDir)
    expect(live).not.toBeNull()
    await callAdminSocket(live!.socketPath, "host.stop", { reason: "restarting" })
    expect(await startPromise).toBe(0)

    const signals2 = new TestSignalSource()
    const io2 = createCapturedIo()
    const startPromise2 = runHeadlessCli(
      ["--profile-dir", profileDir, "start", "--lan-port", "false", "--no-shell-env"],
      {
        ...io2,
        env: { PIGCODE_CORE_PROFILE_DIR: runtimeRoot, PATH: "/usr/bin" },
        signalSource: signals2,
      },
    )
    await vi.waitFor(() => expect(io2.readStdout()).toContain("局域网地址: 已禁用"))
    signals2.emit("SIGTERM")
    expect(await startPromise2).toBe(0)
  })

  it("suppresses started banner when SIGINT arrives during readyLanAddresses()", async () => {
    const root = await temps.makeDir()
    const profileDir = join(root, "profile")
    const runtimeRoot = join(root, "runtime")
    await writeMinimalRuntimeProfile(runtimeRoot)

    const signals = new TestSignalSource()
    const io = createCapturedIo()
    vi.spyOn(MobileConnections.prototype, "readyLanAddresses").mockImplementation(async () => {
      signals.emit("SIGINT")
      return ["127.0.0.1:39871"]
    })

    const code = await runHeadlessCli(
      ["--profile-dir", profileDir, "start", "--lan-port", "0", "--no-shell-env", "--json"],
      {
        ...io,
        env: { PIGCODE_CORE_PROFILE_DIR: runtimeRoot },
        signalSource: signals,
      },
    )
    expect(code).toBe(0)
    expect(io.readStdout()).not.toContain('"event":"started"')
    expect(await probeLiveHost(profileDir)).toBeNull()
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  it("exits 1 with friendly Chinese message when start detects existing live host", async () => {
    const profileDir = await temps.makeDir()
    const { server, socketPath } = await startFixtureAdminServer(profileDir)
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "desktop", socketPath })
    cleanups.push(() => lock.release())

    const io = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "start", "--no-shell-env"], io)).toBe(
      1,
    )
    expect(io.readStderr()).toContain(String(process.pid))
    expect(io.readStderr()).toContain("desktop")
  })

  it("reports online/offline status without creating nonexistent profileDir", async () => {
    const root = await temps.makeDir()
    const missingDir = join(root, "never-created")
    const ioMissing = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", missingDir, "status"], ioMissing)).toBe(1)
    expect(existsSync(missingDir)).toBe(false)

    const profileDir = await temps.makeDir()
    const ctx = new Context()
    await ctx.plugin(settingsPlugin, { path: join(profileDir, "settings.json") })
    const relay = new RelaySettings(
      ctx.settings,
      createLocalCredentialCipher(profileDir),
      async () => "ok",
    )
    await relay.testAndSave({ address: "wss://offline-relay.example", token: "tok" })
    new PairedDevices(ctx.settings).save(makePairedDevice(11, "Offline Phone", "ios"))
    await ctx.fiber.dispose()

    const offlineIo = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "status"], offlineIo)).toBe(1)
    expect(offlineIo.readStdout()).toContain("Host 未运行")
    expect(offlineIo.readStdout()).toContain("已配对设备: 1")

    const offlineJsonIo = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "status", "--json"], offlineJsonIo),
    ).toBe(1)
    expect(JSON.parse(offlineJsonIo.readStdout())).toMatchObject({
      running: false,
      profileDir: resolve(profileDir),
      pairedDevices: 1,
      relay: { address: "wss://offline-relay.example/ws/v1/connect", tokenConfigured: true },
    })

    const { server, socketPath } = await startFixtureAdminServer(profileDir)
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const onlineIo = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "status"], onlineIo)).toBe(0)
    expect(onlineIo.readStdout()).toContain("192.168.1.20:39871")
    expect(onlineIo.readStdout()).toContain("wss://relay.example/ws/v1/connect")

    const onlineJsonIo = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "status", "--json"], onlineJsonIo),
    ).toBe(0)
    expect(JSON.parse(onlineJsonIo.readStdout())).toMatchObject({
      running: true,
      runtime: "headless",
      activeRuns: 1,
      pendingApprovals: 2,
    })
  })
})

describe("runHeadlessCli - relay", () => {
  it("validates relay set arguments and rejects non-TTY without token", async () => {
    const profileDir = await temps.makeDir()
    const ioNoAddr = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "relay", "set"], ioNoAddr)).toBe(2)

    const ioBoth = createCapturedIo()
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          "wss://relay.example",
          "--token",
          "abc",
          "--token-stdin",
        ],
        ioBoth,
      ),
    ).toBe(2)

    const ioNonTty = createCapturedIo(false)
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "relay", "set", "--address", "wss://relay.example"],
        ioNonTty,
      ),
    ).toBe(2)
  })

  it("saves relay offline via --token-stdin, views status, handles probe error, and clears", async () => {
    const profileDir = await temps.makeDir()
    const probe = vi.fn().mockResolvedValueOnce("ok").mockResolvedValueOnce("token-rejected")

    const ioSave = createCapturedIo()
    ioSave.stdin.end("my-secret-token\r\n")
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          "wss://relay.example",
          "--token-stdin",
        ],
        { ...ioSave, relayProbe: probe },
      ),
    ).toBe(0)
    expect(probe).toHaveBeenCalledWith("wss://relay.example/ws/v1/connect", "my-secret-token")

    const ctx = new Context()
    await ctx.plugin(settingsPlugin, { path: join(profileDir, "settings.json") })
    const relay = new RelaySettings(ctx.settings, createLocalCredentialCipher(profileDir))
    expect(await relay.connectionConfig()).toEqual({
      address: "wss://relay.example/ws/v1/connect",
      token: "my-secret-token",
    })
    await ctx.fiber.dispose()

    const ioStatus = createCapturedIo()
    expect(
      await runHeadlessCli(["--profile-dir", profileDir, "relay", "status", "--json"], ioStatus),
    ).toBe(0)
    expect(JSON.parse(ioStatus.readStdout())).toMatchObject({
      running: false,
      address: "wss://relay.example/ws/v1/connect",
      tokenConfigured: true,
    })

    const ioRejected = createCapturedIo()
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          "wss://relay.example",
          "--token",
          "bad",
        ],
        { ...ioRejected, relayProbe: probe },
      ),
    ).toBe(1)
    expect(ioRejected.readStderr()).toContain("访问令牌")

    const ioClear = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "relay", "clear"], ioClear)).toBe(0)

    const ioAfterClear = createCapturedIo()
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "relay", "status", "--json"],
        ioAfterClear,
      ),
    ).toBe(0)
    expect(JSON.parse(ioAfterClear.readStdout())).toMatchObject({ tokenConfigured: false })
  })

  it("rejects empty/oversized --token-stdin and avoids creating profileDir for invalid --address", async () => {
    const root = await temps.makeDir()
    const badAddrDir = join(root, "bad-addr-profile")
    const ioInvalidAddr = createCapturedIo()
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          badAddrDir,
          "relay",
          "set",
          "--address",
          "ws://insecure.example",
          "--token",
          "tok",
        ],
        ioInvalidAddr,
      ),
    ).toBe(1)
    expect(existsSync(badAddrDir)).toBe(false)

    const profileDir = await temps.makeDir()
    const ioEmptyStdin = createCapturedIo()
    ioEmptyStdin.stdin.end("  \n")
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          "wss://relay.example",
          "--token-stdin",
        ],
        ioEmptyStdin,
      ),
    ).toBe(2)

    const ioOver4k = createCapturedIo()
    ioOver4k.stdin.end("a".repeat(4097))
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          "wss://relay.example",
          "--token-stdin",
        ],
        ioOver4k,
      ),
    ).toBe(2)
    expect(existsSync(join(profileDir, "settings.json"))).toBe(false)

    const ioOver16k = createCapturedIo()
    ioOver16k.stdin.end("b".repeat(16_385))
    expect(
      await runHeadlessCli(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          "wss://relay.example",
          "--token-stdin",
        ],
        ioOver16k,
      ),
    ).toBe(2)
  })

  it("updates and clears relay online through admin socket when host is running", async () => {
    const profileDir = await temps.makeDir()
    const testAndSave = vi.fn().mockResolvedValue({
      status: "saved",
      settings: { address: "wss://hot.example/ws/v1/connect", tokenConfigured: true },
    })
    const clear = vi.fn().mockResolvedValue({ address: null, tokenConfigured: false })
    const { server, socketPath } = await startFixtureAdminServer(profileDir, {
      "relay.testAndSave": testAndSave,
      "relay.clear": clear,
    })
    cleanups.push(() => server.close())
    const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
    cleanups.push(() => lock.release())

    const ioSet = createCapturedIo(true)
    expect(
      await runHeadlessCli(
        ["--profile-dir", profileDir, "relay", "set", "--address", "wss://hot.example"],
        {
          ...ioSet,
          readHiddenInput: async () => "tty-token",
        },
      ),
    ).toBe(0)
    expect(testAndSave).toHaveBeenCalledWith({ address: "wss://hot.example", token: "tty-token" })

    const ioClear = createCapturedIo()
    expect(await runHeadlessCli(["--profile-dir", profileDir, "relay", "clear"], ioClear)).toBe(0)
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
