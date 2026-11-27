/** 无窗口 Host（headless.mjs）经真实 Go 中继与 Dart 客户端完成配对、状态查询与撤销配对的端到端验收。 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { LOCAL_CREDENTIAL_PREFIX } from "../services/local-credential"

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN
const headlessEntry = fileURLToPath(
  new URL("../../out/headless/host/headless.mjs", import.meta.url),
)
const mobileDir = fileURLToPath(new URL("../../../mobile", import.meta.url))

interface LineReader {
  nextLine(timeoutMs?: number): Promise<string>
  close(): void
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

function createLineReader(
  stream: NodeJS.ReadableStream,
  label: string,
  getDiagnostics: () => string,
): LineReader {
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
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
      waiters.shift()!.reject(new Error(`${label} 标准输出提前关闭: ${getDiagnostics()}`))
    }
  })

  return {
    nextLine(timeoutMs = 20_000): Promise<string> {
      const queued = buffered.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      if (closed) {
        return Promise.reject(new Error(`${label} 标准输出已关闭: ${getDiagnostics()}`))
      }
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
          rejectLine(new Error(`${label} 等待输出超时: ${getDiagnostics()}`))
        }, timeoutMs)
        waiters.push(entry)
      })
    },
    close() {
      rl.close()
    },
  }
}

function waitForChildExit(
  child: ChildProcess,
  label: string,
  getDiagnostics: () => string,
  timeoutMs = 20_000,
): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup()
      rejectExit(new Error(`${label} 等待退出超时: ${getDiagnostics()}`))
    }, timeoutMs)
    const onError = (error: Error): void => {
      cleanup()
      rejectExit(error)
    }
    const onClose = (code: number | null): void => {
      cleanup()
      resolveExit(code)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off("error", onError)
      child.off("close", onClose)
    }
    child.once("error", onError)
    child.once("close", onClose)
  })
}

async function runHeadlessCliCommand(
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdinText?: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [headlessEntry, ...args], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  child.stdin.end(options.stdinText ?? "")

  try {
    const code = await waitForChildExit(
      child,
      `headless ${args.join(" ")}`,
      () => `stdout=${stdout} stderr=${stderr}`,
      options.timeoutMs ?? 15_000,
    )
    return { code, stdout, stderr }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}

async function stopChildBestEffort(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill("SIGKILL")
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(resolveStop, 2_000)
    child.once("close", () => {
      clearTimeout(timer)
      resolveStop()
    })
  })
}

it.skipIf(!address || !token)(
  "boots headless.mjs, saves relay credentials, pairs Dart over Go relay, revokes device, and cleans up on SIGINT",
  async () => {
    if (!address || !token) return
    if (!existsSync(headlessEntry)) {
      throw new Error("Run pnpm build:headless before running headless-pairing.test.ts")
    }

    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-hp-"))
    const resolvedProfileDir = resolve(profileDir)
    const childEnv = buildChildEnv()

    let daemon: ChildProcess | undefined
    let pairProc: ChildProcess | undefined
    let dartProc: ChildProcess | undefined
    let daemonReader: LineReader | undefined
    let pairReader: LineReader | undefined
    let dartReader: LineReader | undefined

    try {
      // 1-2. 启动纯 Node 无窗口 Host 常驻进程并校验 started 事件、0600 密钥与 host.lock。
      daemon = spawn(
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
        {
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      let daemonStderr = ""
      daemon.stderr!.setEncoding("utf8")
      daemon.stderr!.on("data", (chunk: string) => {
        daemonStderr += chunk
      })
      const daemonExitPromise = waitForChildExit(
        daemon,
        "headless start",
        () => daemonStderr,
        20_000,
      )
      daemonReader = createLineReader(daemon.stdout!, "headless start", () => daemonStderr)

      const started = JSON.parse(await daemonReader.nextLine(20_000)) as {
        event: string
        pid: number
        runtime: string
        profileDir: string
        socketPath: string
        lanAddresses: string[]
      }
      expect(started).toMatchObject({
        event: "started",
        pid: daemon.pid,
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
      const lockMeta = JSON.parse(readFileSync(lockPath, "utf8")) as {
        pid: number
        runtime: string
        socketPath: string
      }
      expect(lockMeta).toMatchObject({
        pid: daemon.pid,
        runtime: "headless",
        socketPath: started.socketPath,
      })
      expect(existsSync(started.socketPath)).toBe(true)

      // 3. 通过 --token-stdin 配置 Go 中继地址与访问令牌，确认 settings.json 仅保存密文。
      const relaySetRes = await runHeadlessCliCommand(
        [
          "--profile-dir",
          profileDir,
          "relay",
          "set",
          "--address",
          address,
          "--token-stdin",
          "--json",
        ],
        { env: childEnv, stdinText: `${token}\n` },
      )
      expect(relaySetRes.code, relaySetRes.stderr).toBe(0)
      expect(JSON.parse(relaySetRes.stdout.trim())).toMatchObject({ status: "saved" })

      const settingsPath = join(profileDir, "settings.json")
      const settingsRaw = readFileSync(settingsPath, "utf8")
      expect(settingsRaw).not.toContain(token)
      const settingsJson = JSON.parse(settingsRaw) as {
        "relay.connection"?: { address?: string; sealedToken?: string }
      }
      expect(
        settingsJson["relay.connection"]?.sealedToken?.startsWith(LOCAL_CREDENTIAL_PREFIX),
      ).toBe(true)

      // 4. 启动交互式 pair --json，与 Dart 客户端经真实 Go 中继完成核对与确认。
      pairProc = spawn(
        process.execPath,
        [headlessEntry, "--profile-dir", profileDir, "pair", "--json"],
        {
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      let pairStderr = ""
      pairProc.stderr!.setEncoding("utf8")
      pairProc.stderr!.on("data", (chunk: string) => {
        pairStderr += chunk
      })
      const pairExitPromise = waitForChildExit(pairProc, "headless pair", () => pairStderr, 30_000)
      pairReader = createLineReader(pairProc.stdout!, "headless pair", () => pairStderr)

      const waiting = JSON.parse(await pairReader.nextLine(15_000)) as {
        event: string
        attemptId: string
        qr?: string
      }
      expect(waiting.event).toBe("waiting")
      if (!waiting.qr) throw new Error("headless pair did not output a QR payload")

      dartProc = spawn("dart", ["run", "scripts/verify-pairing.dart"], {
        cwd: mobileDir,
        env: buildChildEnv({ PIGCODE_TEST_PAIRING_QR: waiting.qr }),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let dartStderr = ""
      dartProc.stderr!.setEncoding("utf8")
      dartProc.stderr!.on("data", (chunk: string) => {
        dartStderr += chunk
      })
      const dartExitTimeout =
        30_000 + (Number(process.env.PIGCODE_RELAY_TEST_IDLE_SECONDS) || 0) * 1000
      const dartExitPromise = waitForChildExit(
        dartProc,
        "verify-pairing.dart",
        () => dartStderr,
        dartExitTimeout,
      )
      dartReader = createLineReader(dartProc.stdout!, "verify-pairing.dart", () => dartStderr)

      // 电脑确认前手机端必须被拒绝访问 RPC，且 devices --json 仍为空列表。
      expect(JSON.parse(await dartReader.nextLine(25_000))).toEqual({ stage: "blocked" })
      const devicesBeforeConfirm = await runHeadlessCliCommand(
        ["--profile-dir", profileDir, "devices", "--json"],
        { env: childEnv },
      )
      expect(devicesBeforeConfirm.code, devicesBeforeConfirm.stderr).toBe(0)
      expect(JSON.parse(devicesBeforeConfirm.stdout.trim())).toMatchObject({
        running: true,
        devices: [],
      })

      // 等待 Dart 与 CLI 两端同时输出 6 位核对码并校验完全一致，再通过 stdin 写入确认。
      const [dartCodeRaw, cliVerifyRaw] = await Promise.all([
        dartReader.nextLine(20_000),
        pairReader.nextLine(20_000),
      ])
      const dartCode = JSON.parse(dartCodeRaw) as { stage: string; code?: string }
      const cliVerify = JSON.parse(cliVerifyRaw) as {
        event: string
        attemptId?: string
        code?: string
        name?: string
        mode?: string
      }
      expect(dartCode.stage).toBe("code")
      expect(dartCode.code).toMatch(/^\d{6}$/)
      expect(cliVerify).toMatchObject({
        event: "verify",
        attemptId: waiting.attemptId,
        code: dartCode.code,
        name: "验收手机",
        mode: "pair",
      })

      pairProc.stdin!.write("y\n")
      const [cliPairedRaw, dartVerifiedRaw, pairExitCode, dartExitCode] = await Promise.all([
        pairReader.nextLine(15_000),
        dartReader.nextLine(dartExitTimeout),
        pairExitPromise,
        dartExitPromise,
      ])
      expect(JSON.parse(cliPairedRaw)).toMatchObject({
        event: "paired",
        status: "paired",
        attemptId: waiting.attemptId,
        name: "验收手机",
        mode: "pair",
      })
      expect(JSON.parse(dartVerifiedRaw)).toEqual({ stage: "verified" })
      expect(pairExitCode, pairStderr).toBe(0)
      expect(dartExitCode, dartStderr).toBe(0)

      // 5. 查询运行状态：已配对设备数为 1、中继令牌已配置、存在局域网地址。
      const statusRes = await runHeadlessCliCommand(
        ["--profile-dir", profileDir, "status", "--json"],
        { env: childEnv },
      )
      expect(statusRes.code, statusRes.stderr).toBe(0)
      const statusJson = JSON.parse(statusRes.stdout.trim()) as {
        running: boolean
        runtime: string
        pairedDevices: number
        relay: { address: string | null; tokenConfigured: boolean }
        lanAddresses: string[]
      }
      expect(statusJson).toMatchObject({
        running: true,
        runtime: "headless",
        pairedDevices: 1,
        relay: { tokenConfigured: true },
      })
      expect(statusJson.lanAddresses.length).toBeGreaterThanOrEqual(1)

      // 6. 列出设备、按编号前缀撤销配对并确认列表清空。
      const devicesRes = await runHeadlessCliCommand(
        ["--profile-dir", profileDir, "devices", "--json"],
        { env: childEnv },
      )
      expect(devicesRes.code, devicesRes.stderr).toBe(0)
      const devicesJson = JSON.parse(devicesRes.stdout.trim()) as {
        devices: Array<{ id: string; name: string; platform: string }>
      }
      expect(devicesJson.devices).toHaveLength(1)
      expect(devicesJson.devices[0]).toMatchObject({ name: "验收手机", platform: "ios" })

      const idPrefix = devicesJson.devices[0]!.id.slice(0, 8)
      const revokeRes = await runHeadlessCliCommand(
        ["--profile-dir", profileDir, "revoke", idPrefix, "--yes", "--json"],
        { env: childEnv },
      )
      expect(revokeRes.code, revokeRes.stderr).toBe(0)
      expect(JSON.parse(revokeRes.stdout.trim())).toMatchObject({
        status: "revoked",
        pairing: { devices: [] },
      })

      const devicesAfterRevoke = await runHeadlessCliCommand(
        ["--profile-dir", profileDir, "devices", "--json"],
        { env: childEnv },
      )
      expect(devicesAfterRevoke.code, devicesAfterRevoke.stderr).toBe(0)
      expect(JSON.parse(devicesAfterRevoke.stdout.trim())).toMatchObject({ devices: [] })

      // 7. 向无窗口常驻进程发送 SIGINT，确认返回退出码 0 且锁文件与控制通道均已移除。
      daemon.kill("SIGINT")
      expect(await daemonExitPromise, daemonStderr).toBe(0)
      expect(existsSync(lockPath)).toBe(false)
      expect(existsSync(started.socketPath)).toBe(false)
      expect(existsSync(join(profileDir, "host.sock"))).toBe(false)
    } finally {
      dartReader?.close()
      pairReader?.close()
      daemonReader?.close()
      await stopChildBestEffort(dartProc)
      await stopChildBestEffort(pairProc)
      await stopChildBestEffort(daemon)
      await rm(profileDir, { recursive: true, force: true })
    }
  },
  60_000 + (Number(process.env.PIGCODE_RELAY_TEST_IDLE_SECONDS) || 0) * 1000,
)
