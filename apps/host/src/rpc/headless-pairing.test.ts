/** 无窗口 Host（headless.mjs）经真实 Go 中继与 Dart 客户端完成配对、状态查询与撤销配对的端到端验收。 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { callAdminSocket } from "../kernel/admin-socket"
import { canConnectSocket } from "../kernel/host-lock"
import { LOCAL_CREDENTIAL_PREFIX } from "../services/local-credential"

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN
const idleSeconds = Number(process.env.PIGCODE_RELAY_TEST_IDLE_SECONDS) || 0
const headlessEntry = fileURLToPath(
  new URL("../../out/headless/host/headless.mjs", import.meta.url),
)
const mobileDir = fileURLToPath(new URL("../../../mobile", import.meta.url))

interface ProcessExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error | undefined
}

interface ProcessWatcher {
  readonly label: string
  readonly diagnostics: () => string
  onExit(listener: (info: ProcessExitInfo) => void): () => void
  awaitExit(timeoutMs?: number): Promise<number | null>
}

interface WatchedProcess {
  readonly child: ChildProcess
  readonly watcher: ProcessWatcher
  nextLine(timeoutMs?: number): Promise<string>
  nextJson<T>(timeoutMs?: number): Promise<T>
  stdout(): string
  stderr(): string
  cleanup(): Promise<void>
}

function buildChildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.PIGCODE_PROFILE_DIR
  delete env.PIGCODE_DB_PATH
  delete env.PIGCODE_CREDENTIAL_KEY
  if (process.env.PIGCODE_RELAY_TEST_CA && !env.NODE_EXTRA_CA_CERTS?.trim()) {
    env.NODE_EXTRA_CA_CERTS = process.env.PIGCODE_RELAY_TEST_CA
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
  return env
}

/** 仅记录子进程提前退出或启动错误，不在生成时启动倒计时；退出超时仅在进入 awaitExit 时开始计时。 */
function createProcessWatcher(
  child: ChildProcess,
  label: string,
  diagnostics: () => string,
): ProcessWatcher {
  let exitInfo: ProcessExitInfo | undefined
  const listeners = new Set<(info: ProcessExitInfo) => void>()

  const settle = (info: ProcessExitInfo): void => {
    if (exitInfo) return
    exitInfo = info
    for (const listener of [...listeners]) listener(info)
    listeners.clear()
  }

  child.once("error", (error) => settle({ code: child.exitCode, signal: child.signalCode, error }))
  child.once("close", (code, signal) => settle({ code, signal }))

  const onExit = (listener: (info: ProcessExitInfo) => void): (() => void) => {
    if (exitInfo) {
      listener(exitInfo)
      return () => undefined
    }
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    label,
    diagnostics,
    onExit,
    awaitExit(timeoutMs = 20_000): Promise<number | null> {
      if (exitInfo) {
        return exitInfo.error ? Promise.reject(exitInfo.error) : Promise.resolve(exitInfo.code)
      }
      return new Promise((resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          unsubscribe()
          rejectExit(new Error(`${label} 等待退出超时: ${diagnostics()}`))
        }, timeoutMs)
        const unsubscribe = onExit((info) => {
          clearTimeout(timer)
          if (info.error) rejectExit(info.error)
          else resolveExit(info.code)
        })
      })
    },
  }
}

/** 在当前 await 期间监听子进程意外退出，结束后立即解绑，避免未捕获拒绝或残留定时器。 */
async function raceEarlyExit<T>(watchers: ProcessWatcher[], work: Promise<T>): Promise<T> {
  const cleanups: Array<() => void> = []
  const early = new Promise<never>((_resolve, reject) => {
    for (const watcher of watchers) {
      cleanups.push(
        watcher.onExit((info) => {
          reject(
            info.error ??
              new Error(
                `${watcher.label} 意外提前退出 (code=${info.code}, signal=${info.signal}): ${watcher.diagnostics()}`,
              ),
          )
        }),
      )
    }
  })
  try {
    return await Promise.race([work, early])
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
}

async function stopChildBestEffort(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.off("close", onClose)
      resolveStop()
    }, 2_000)
    const onClose = (): void => {
      clearTimeout(timer)
      resolveStop()
    }
    child.once("close", onClose)
    child.kill("SIGKILL")
  })
}

function spawnWatchedProcess(
  command: string,
  args: string[],
  options: { label: string; env: NodeJS.ProcessEnv; cwd?: string; stdinMode: "ignore" | "pipe" },
): WatchedProcess {
  const stdio: StdioOptions = [options.stdinMode, "pipe", "pipe"]
  const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio })
  let stdout = ""
  let stderr = ""
  child.stdout!.setEncoding("utf8")
  child.stderr!.setEncoding("utf8")
  child.stdout!.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk
  })

  const diagnostics = () => `stdout=${stdout} stderr=${stderr}`
  const watcher = createProcessWatcher(child, options.label, diagnostics)
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  const buffered: string[] = []
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = []
  let closed = false

  rl.on("line", (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(line)
    else buffered.push(line)
  })
  rl.on("close", () => {
    closed = true
    while (waiters.length > 0) {
      waiters.shift()!.reject(new Error(`${options.label} 标准输出提前关闭: ${diagnostics()}`))
    }
  })

  const nextLine = (timeoutMs = 20_000): Promise<string> => {
    const queued = buffered.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (closed)
      return Promise.reject(new Error(`${options.label} 标准输出已关闭: ${diagnostics()}`))
    return new Promise((resolveLine, rejectLine) => {
      const entry = {
        resolve: (line: string) => {
          clearTimeout(timer)
          resolveLine(line)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          rejectLine(error)
        },
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(entry)
        if (index >= 0) waiters.splice(index, 1)
        rejectLine(new Error(`${options.label} 等待输出超时: ${diagnostics()}`))
      }, timeoutMs)
      waiters.push(entry)
    })
  }

  return {
    child,
    watcher,
    nextLine,
    async nextJson<T>(timeoutMs = 20_000): Promise<T> {
      return JSON.parse(await nextLine(timeoutMs)) as T
    },
    stdout: () => stdout,
    stderr: () => stderr,
    async cleanup() {
      rl.close()
      await stopChildBestEffort(child)
    },
  }
}

async function runCliJson<T>(
  profileDir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  watchers: ProcessWatcher[],
  stdinText = "",
): Promise<T> {
  const proc = spawnWatchedProcess(
    process.execPath,
    [headlessEntry, "--profile-dir", profileDir, ...args, "--json"],
    { label: `headless ${args.join(" ")}`, env, stdinMode: "pipe" },
  )
  proc.child.stdin!.end(stdinText)
  try {
    const code = await raceEarlyExit(watchers, proc.watcher.awaitExit(15_000))
    expect(code, proc.stderr()).toBe(0)
    return JSON.parse(proc.stdout().trim()) as T
  } finally {
    await proc.cleanup()
  }
}

it.skipIf(!address || !token)(
  "boots headless.mjs, saves relay credentials, pairs Dart over Go relay, revokes device, and cleans up on exit",
  async () => {
    if (!address || !token) return
    if (!existsSync(headlessEntry)) {
      throw new Error("Run pnpm build:headless before running headless-pairing.test.ts")
    }

    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-hp-"))
    const resolvedProfileDir = resolve(profileDir)
    const childEnv = buildChildEnv()

    let daemonProc: WatchedProcess | undefined
    let pairProc: WatchedProcess | undefined
    let dartProc: WatchedProcess | undefined

    try {
      // 1-2. 启动纯 Node 无窗口 Host 常驻进程并校验 started 事件、0600 密钥与 host.lock。
      daemonProc = spawnWatchedProcess(
        process.execPath,
        [
          headlessEntry,
          "start",
          "--profile-dir",
          profileDir,
          "--lan-port",
          "0",
          "--no-shell-env",
          "--json",
        ],
        { label: "headless start", env: childEnv, stdinMode: "ignore" },
      )

      const started = await raceEarlyExit(
        [daemonProc.watcher],
        daemonProc.nextJson<{
          event: string
          pid: number
          runtime: string
          profileDir: string
          socketPath: string
          lanAddresses: string[]
        }>(20_000),
      )
      expect(started).toMatchObject({
        event: "started",
        pid: daemonProc.child.pid,
        runtime: "headless",
        profileDir: resolvedProfileDir,
      })
      expect(started.lanAddresses.length).toBeGreaterThanOrEqual(1)

      const keyPath = join(profileDir, "credential.key")
      expect(existsSync(keyPath)).toBe(true)
      if (process.platform !== "win32") {
        expect(statSync(keyPath).mode & 0o777).toBe(0o600)
      }

      const lockPath = join(profileDir, "host.lock")
      expect(existsSync(lockPath)).toBe(true)
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
        pid: daemonProc.child.pid,
        runtime: "headless",
        socketPath: started.socketPath,
      })
      if (process.platform === "win32") {
        await expect(canConnectSocket(started.socketPath)).resolves.toBe(true)
      } else {
        expect(existsSync(started.socketPath)).toBe(true)
      }

      // 3. 通过 --token-stdin 配置 Go 中继地址与访问令牌，确认 settings.json 仅保存密文。
      const relaySet = await runCliJson<{ status: string }>(
        profileDir,
        ["relay", "set", "--address", address, "--token-stdin"],
        childEnv,
        [daemonProc.watcher],
        `${token}\n`,
      )
      expect(relaySet).toMatchObject({ status: "saved" })

      const settingsRaw = readFileSync(join(profileDir, "settings.json"), "utf8")
      expect(settingsRaw).not.toContain(token)
      const settingsJson = JSON.parse(settingsRaw) as {
        "relay.connection"?: { sealedToken?: string }
      }
      expect(
        settingsJson["relay.connection"]?.sealedToken?.startsWith(LOCAL_CREDENTIAL_PREFIX),
      ).toBe(true)

      // 4. 启动交互式 pair --json，与 Dart 客户端经真实 Go 中继完成核对与确认。
      pairProc = spawnWatchedProcess(
        process.execPath,
        [headlessEntry, "--profile-dir", profileDir, "pair", "--json"],
        { label: "headless pair", env: childEnv, stdinMode: "pipe" },
      )
      const waiting = await raceEarlyExit(
        [daemonProc.watcher, pairProc.watcher],
        pairProc.nextJson<{ event: string; attemptId: string; qr?: string }>(15_000),
      )
      expect(waiting.event).toBe("waiting")
      if (!waiting.qr) throw new Error("headless pair did not output a QR payload")

      dartProc = spawnWatchedProcess("dart", ["run", "scripts/verify-pairing.dart"], {
        label: "verify-pairing.dart",
        cwd: mobileDir,
        env: buildChildEnv({ PIGCODE_TEST_PAIRING_QR: waiting.qr }),
        stdinMode: "ignore",
      })
      const liveWatchers = [daemonProc.watcher, pairProc.watcher, dartProc.watcher]

      // 电脑确认前手机端必须被拒绝访问 RPC，且 devices --json 仍为空列表。
      expect(await raceEarlyExit(liveWatchers, dartProc.nextJson(25_000))).toEqual({
        stage: "blocked",
      })
      const devicesBeforeConfirm = await runCliJson<{ running: boolean; devices: unknown[] }>(
        profileDir,
        ["devices"],
        childEnv,
        liveWatchers,
      )
      expect(devicesBeforeConfirm).toMatchObject({ running: true, devices: [] })

      // 等待 Dart 与 CLI 两端同时输出 6 位核对码并校验完全一致，再通过 stdin 写入确认。
      const [dartCode, cliVerify] = await raceEarlyExit(
        liveWatchers,
        Promise.all([
          dartProc.nextJson<{ stage: string; code?: string }>(20_000),
          pairProc.nextJson<{
            event: string
            attemptId?: string
            code?: string
            name?: string
            mode?: string
          }>(20_000),
        ]),
      )
      expect(dartCode.stage).toBe("code")
      expect(dartCode.code).toMatch(/^\d{6}$/)
      expect(cliVerify).toMatchObject({
        event: "verify",
        attemptId: waiting.attemptId,
        code: dartCode.code,
        name: "验收手机",
        mode: "pair",
      })

      const pairDoneTimeoutMs = 30_000 + idleSeconds * 1000
      pairProc.child.stdin!.write("y\n")
      const [cliPaired, dartVerified, pairExitCode, dartExitCode] = await raceEarlyExit(
        [daemonProc.watcher],
        Promise.all([
          pairProc.nextJson(15_000),
          dartProc.nextJson(pairDoneTimeoutMs),
          pairProc.watcher.awaitExit(pairDoneTimeoutMs),
          dartProc.watcher.awaitExit(pairDoneTimeoutMs),
        ]),
      )
      expect(cliPaired).toMatchObject({
        event: "paired",
        status: "paired",
        attemptId: waiting.attemptId,
        name: "验收手机",
        mode: "pair",
      })
      expect(dartVerified).toEqual({ stage: "verified" })
      expect(pairExitCode, pairProc.stderr()).toBe(0)
      expect(dartExitCode, dartProc.stderr()).toBe(0)

      // 5. 查询运行状态：已配对设备数为 1、中继令牌已配置、存在局域网地址。
      const statusJson = await runCliJson<{
        running: boolean
        runtime: string
        pairedDevices: number
        relay: { tokenConfigured: boolean }
        lanAddresses: string[]
      }>(profileDir, ["status"], childEnv, [daemonProc.watcher])
      expect(statusJson).toMatchObject({
        running: true,
        runtime: "headless",
        pairedDevices: 1,
        relay: { tokenConfigured: true },
      })
      expect(statusJson.lanAddresses.length).toBeGreaterThanOrEqual(1)

      // 6. 列出设备、按编号前缀撤销配对并确认列表清空。
      const devicesJson = await runCliJson<{
        devices: Array<{ id: string; name: string; platform: string }>
      }>(profileDir, ["devices"], childEnv, [daemonProc.watcher])
      expect(devicesJson.devices).toHaveLength(1)
      expect(devicesJson.devices[0]).toMatchObject({ name: "验收手机", platform: "ios" })

      const idPrefix = devicesJson.devices[0]!.id.slice(0, 8)
      const revokeJson = await runCliJson<{ status: string; pairing: { devices: unknown[] } }>(
        profileDir,
        ["revoke", idPrefix, "--yes"],
        childEnv,
        [daemonProc.watcher],
      )
      expect(revokeJson).toMatchObject({ status: "revoked", pairing: { devices: [] } })

      const devicesAfterRevoke = await runCliJson<{ devices: unknown[] }>(
        profileDir,
        ["devices"],
        childEnv,
        [daemonProc.watcher],
      )
      expect(devicesAfterRevoke).toMatchObject({ devices: [] })

      // 7. 优雅关闭无窗口常驻进程（POSIX 发 SIGINT，Windows 走 host.stop），确认退出码 0 且锁与控制通道均移除。
      if (process.platform === "win32") {
        await callAdminSocket(started.socketPath, "host.stop", { reason: "exited" })
      } else {
        daemonProc.child.kill("SIGINT")
      }
      expect(await daemonProc.watcher.awaitExit(20_000), daemonProc.stderr()).toBe(0)
      expect(existsSync(lockPath)).toBe(false)
      if (process.platform === "win32") {
        await expect(canConnectSocket(started.socketPath)).resolves.toBe(false)
      } else {
        expect(existsSync(started.socketPath)).toBe(false)
        expect(existsSync(join(profileDir, "host.sock"))).toBe(false)
      }
    } finally {
      await dartProc?.cleanup()
      await pairProc?.cleanup()
      await daemonProc?.cleanup()
      await rm(profileDir, { recursive: true, force: true })
    }
  },
  60_000 + idleSeconds * 1000,
)
