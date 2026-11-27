/** 验证终端隐藏输入安全清理、CSI 转义剥离、TOCTOU 探测时机与 bin 入口边界情况。 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PairedDevices, pairedDeviceId } from "../mobile/paired-devices"
import { apply as settingsPlugin } from "../services/settings"
import { runHeadlessCli } from "./headless-cli"
import { readHiddenInputDefault } from "./headless-cli-format"
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

describe("readHiddenInputDefault", () => {
  it("rejects without echoing when TTY lacks setRawMode", async () => {
    const io = createCapturedIo(true)
    await expect(readHiddenInputDefault("Token: ", io.stdin, io.stdout)).rejects.toThrow(
      "当前终端不支持隐藏输入，请改用 --token-stdin",
    )
  })

  it("strips ANSI CSI/SS3 sequences and handles Unicode surrogate-pair backspace", async () => {
    const rawModes: boolean[] = []
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (mode: boolean) => void
    }
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
      rawModes.push(mode)
    }
    const pauseSpy = vi.spyOn(stdin, "pause")
    const io = createCapturedIo(true)
    const signals = new TestSignalSource()

    const pending = readHiddenInputDefault("Token: ", stdin, io.stdout, signals)
    // 发送方向键 CSI（含分包）、bracketed paste 标记、emoji 后退格再提交。
    stdin.write("\x1b[A\x1b")
    stdin.write("[1;5C\x1bOA")
    stdin.write("\x1b[200~a😀b\x7f\x7fc\x1b[201~\r")

    await expect(pending).resolves.toBe("ac")
    expect(rawModes).toEqual([true, false])
    expect(pauseSpy).toHaveBeenCalled()
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  it("restores setRawMode and pauses stdin on SIGINT or premature close", async () => {
    const createRawStdin = () => {
      const stdin = new PassThrough() as PassThrough & {
        isTTY: boolean
        isRaw: boolean
        setRawMode: (mode: boolean) => void
      }
      stdin.isTTY = true
      stdin.isRaw = false
      stdin.setRawMode = (mode) => {
        stdin.isRaw = mode
      }
      return stdin
    }

    const signals = new TestSignalSource()
    const stdinSig = createRawStdin()
    const out1 = createCapturedIo(true).stdout
    const p1 = readHiddenInputDefault("Token: ", stdinSig, out1, signals)
    stdinSig.write("partial")
    signals.emit("SIGINT")
    await expect(p1).resolves.toBeNull()
    expect(stdinSig.isRaw).toBe(false)
    expect(signals.listenerCount("SIGINT")).toBe(0)

    const stdinClose = createRawStdin()
    const pauseSpy = vi.spyOn(stdinClose, "pause")
    const out2 = createCapturedIo(true).stdout
    const p2 = readHiddenInputDefault("Token: ", stdinClose, out2, signals)
    stdinClose.write("partial")
    stdinClose.destroy()
    await expect(p2).resolves.toBeNull()
    expect(stdinClose.isRaw).toBe(false)
    expect(pauseSpy).toHaveBeenCalled()
  })
})

describe("TOCTOU prompt ordering and bin entrypoint hardening", () => {
  it("re-probes live host after user confirms revoke so concurrent host startup is respected", async () => {
    const profileDir = await temps.makeDir()
    const device = makePairedDevice(5, "Race iPhone", "ios")
    const deviceId = pairedDeviceId(device.publicKey)

    const ctx = new Context()
    await ctx.plugin(settingsPlugin, { path: join(profileDir, "settings.json") })
    new PairedDevices(ctx.settings).save(device)
    await ctx.fiber.dispose()

    const revokeOnlineSpy = vi.fn(() => ({
      status: "revoked" as const,
      pairing: { status: "idle" as const, attempt: null, devices: [] },
    }))
    const io = createCapturedIo(true)
    const code = await runHeadlessCli(
      ["--profile-dir", profileDir, "revoke", deviceId.slice(0, 8)],
      {
        ...io,
        confirmPrompt: async () => {
          // 模拟用户在输入确认期间，后台 Host 启动并接管了配置目录。
          const { server, socketPath } = await startFixtureAdminServer(profileDir, {
            "mobile.devices.list": () => [makePairingViewDevice(device)],
            "mobile.devices.revoke": revokeOnlineSpy,
          })
          cleanups.push(() => server.close())
          const lock = await acquireHostLock(profileDir, { runtime: "headless", socketPath })
          cleanups.push(() => lock.release())
          return "y"
        },
      },
    )
    expect(code).toBe(0)
    expect(revokeOnlineSpy).toHaveBeenCalledWith({ deviceId })
  })

  it("resolves symlinked bin path and exits 1 when bundle lacks main export or is missing", async () => {
    const binSource = fileURLToPath(new URL("../../bin/pigcode-host.ts", import.meta.url))
    const tempDir = await temps.makeDir("pigcode-bin-test-")
    const tempBinDir = join(tempDir, "bin")
    const tempHostDir = join(tempDir, "host")
    const linkDir = join(tempDir, "links")
    await mkdir(tempBinDir, { recursive: true })
    await mkdir(linkDir, { recursive: true })
    await writeFile(join(tempBinDir, "pigcode-host.ts"), readFileSync(binSource, "utf8"))
    const symlinkPath = join(linkDir, "pigcode-host")
    await symlink(join(tempBinDir, "pigcode-host.ts"), symlinkPath)

    const missingRes = spawnSync(process.execPath, [symlinkPath, "--help"], { encoding: "utf8" })
    expect(missingRes.status).toBe(1)
    expect(missingRes.stderr).toContain("Pigcode Host 尚未构建，请先运行 pnpm build:headless")

    await mkdir(tempHostDir, { recursive: true })
    await writeFile(join(tempHostDir, "headless.mjs"), "export const notMain = 1\n")
    const brokenRes = spawnSync(process.execPath, [symlinkPath, "--help"], { encoding: "utf8" })
    expect(brokenRes.status).toBe(1)
    expect(brokenRes.stderr).toContain("缺少 main 导出")
  })
})
