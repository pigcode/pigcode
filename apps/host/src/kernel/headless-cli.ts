/** `pigcode-host` 无窗口常驻入口与本机运维 CLI 主调度器。 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { RelayProbe } from "../services/relay-probe"
import { callAdminSocket } from "./admin-socket"
import { createHostApp, dumpConfig } from "./app"
import { bootstrapHostKernel, resolveHostRuntimeRoot, type BootstrappedHost } from "./bootstrap"
import {
  formatHostStatus,
  formatOfflineStatus,
  formatStartSummary,
  type ReadableInputLike,
  type SignalSource,
  type WritableStreamLike,
} from "./headless-cli-format"
import {
  readOfflineSummary,
  runDevicesCommand,
  runRelayCommand,
  runRevokeCommand,
} from "./headless-cli-manage"
import { runPairCommand, type ConfirmPromptFn } from "./headless-cli-pair"
import { formatHelpText, parseHeadlessCliArgs, type GlobalCliOptions } from "./headless-cli-parse"
import { HostAlreadyRunningError, probeLiveHost } from "./host-lock"
import { applyLoginShellEnv, needsLoginShellEnv } from "./login-shell-env"
import { appendCommonCliPaths, resolveProfileDir } from "./profile-paths"

export type { ReadableInputLike, SignalSource, WritableStreamLike } from "./headless-cli-format"
export type { ConfirmPromptFn } from "./headless-cli-pair"

export interface HeadlessCliDeps {
  stdout?: WritableStreamLike | undefined
  stderr?: WritableStreamLike | undefined
  stdin?: ReadableInputLike | undefined
  readHiddenInput?: ((prompt: string) => Promise<string | null>) | undefined
  confirmPrompt?: ConfirmPromptFn | undefined
  env?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
  home?: string | undefined
  signalSource?: SignalSource | undefined
  forceExit?: ((code: number) => never | void) | undefined
  pollIntervalMs?: number | undefined
  relayProbe?: RelayProbe | undefined
  applyLoginShellEnv?: (() => Promise<void>) | undefined
  defaultDumpProfileDir?: string | undefined
}

const DEFAULT_PAIR_POLL_MS = 250

function resolveDumpProfileDir(
  global: GlobalCliOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  defaultDumpProfileDir?: string,
): string {
  const explicitOrEnv = global.profileDir?.trim() || env.PIGCODE_PROFILE_DIR?.trim()
  if (explicitOrEnv) {
    const candidate = resolveProfileDir({ cliProfileDir: explicitOrEnv, env, platform, home })
    if (existsSync(join(candidate, `${global.profileName}.yml`))) return candidate
  }
  const runtimeRoot = resolveHostRuntimeRoot(import.meta.url, env)
  if (existsSync(join(runtimeRoot, `${global.profileName}.yml`))) return runtimeRoot
  const repoProfiles =
    defaultDumpProfileDir ?? fileURLToPath(new URL("../../profiles", import.meta.url))
  if (existsSync(join(repoProfiles, `${global.profileName}.yml`))) return repoProfiles
  return explicitOrEnv
    ? resolveProfileDir({ cliProfileDir: explicitOrEnv, env, platform, home })
    : runtimeRoot
}

async function runDumpConfig(
  global: GlobalCliOptions,
  stdout: WritableStreamLike,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  defaultDumpProfileDir?: string,
): Promise<number> {
  const profileDir = resolveDumpProfileDir(global, env, platform, home, defaultDumpProfileDir)
  const ctx = await createHostApp({ profileDir, profileName: global.profileName })
  try {
    stdout.write(`${JSON.stringify(dumpConfig(ctx), null, 2)}\n`)
    return 0
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runStart(
  profileDir: string,
  profileName: string,
  lanPort: number | false | undefined,
  noShellEnv: boolean,
  json: boolean,
  deps: {
    stdout: WritableStreamLike
    stderr: WritableStreamLike
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    home: string
    signalSource: SignalSource
    forceExit: (code: number) => never | void
    applyShellEnv?: (() => Promise<void>) | undefined
  },
): Promise<number> {
  const { stdout, stderr, env, platform, home, signalSource, forceExit } = deps
  if (!noShellEnv) {
    if (deps.applyShellEnv) {
      await deps.applyShellEnv().catch(() => undefined)
    } else if (env === process.env && needsLoginShellEnv(env, platform)) {
      await applyLoginShellEnv().catch(() => undefined)
    }
    appendCommonCliPaths(env, platform, home)
  }

  const resolvedProfileDir = resolve(profileDir)
  let host: BootstrappedHost | undefined
  let stopPromise: Promise<number> | undefined
  let pendingStopReason: "exited" | "restarting" | undefined
  let resolveExit!: (code: number) => void
  const waitForExit = new Promise<number>((resolvePromise) => {
    resolveExit = resolvePromise
  })

  const beginStop = (reason: "exited" | "restarting", fromSignal?: "SIGINT" | "SIGTERM"): void => {
    if (stopPromise || pendingStopReason) {
      if (fromSignal) {
        forceExit(fromSignal === "SIGTERM" ? 143 : 130)
      }
      return
    }
    if (!host) {
      pendingStopReason = reason
      return
    }
    const activeHost = host
    stopPromise = (async () => {
      let exitCode = 0
      try {
        await activeHost.dispose(reason)
      } catch (error) {
        exitCode = 1
        const message = error instanceof Error ? error.message : String(error)
        stderr.write(`停止 Pigcode Host 时出错: ${message}\n`)
      } finally {
        resolveExit(exitCode)
      }
      return exitCode
    })()
  }

  const flushPendingStop = (): Promise<number> | undefined => {
    if (!pendingStopReason) return undefined
    const reason = pendingStopReason
    pendingStopReason = undefined
    beginStop(reason)
    return waitForExit
  }

  const onSigInt = (): void => beginStop("exited", "SIGINT")
  const onSigTerm = (): void => beginStop("exited", "SIGTERM")
  signalSource.on("SIGINT", onSigInt)
  signalSource.on("SIGTERM", onSigTerm)

  try {
    host = await bootstrapHostKernel({
      profileDir: resolvedProfileDir,
      profileName,
      runtime: "headless",
      lanPort,
      runtimeRoot: resolveHostRuntimeRoot(import.meta.url, env),
      onStopRequested: (reason) => beginStop(reason),
    })

    const earlyStop = flushPendingStop()
    if (earlyStop) return await earlyStop

    const lanAddresses = await host.mobile.readyLanAddresses()
    const relay = host.relay.view()
    const lanWaitStop = flushPendingStop()
    if (lanWaitStop) return await lanWaitStop

    if (json) {
      stdout.write(
        `${JSON.stringify({
          event: "started",
          pid: process.pid,
          runtime: host.runtime,
          profileDir: resolvedProfileDir,
          socketPath: host.socketPath,
          lanAddresses,
          relay,
          pairedDevices: host.mobile.view().devices.length,
        })}\n`,
      )
    } else {
      stdout.write(
        `${formatStartSummary({
          profileDir: resolvedProfileDir,
          pid: process.pid,
          socketPath: host.socketPath,
          lanAddresses,
          lanPort,
          relay,
        })}\n`,
      )
    }

    return await waitForExit
  } catch (error) {
    if (error instanceof HostAlreadyRunningError) {
      if (json) {
        stdout.write(
          `${JSON.stringify({
            event: "error",
            code: "host_already_running",
            profileDir: resolvedProfileDir,
            owner: error.owner,
          })}\n`,
        )
      } else {
        stderr.write(
          `Pigcode Host 已在运行（运行模式: ${error.owner.runtime}, PID: ${error.owner.pid}, 配置目录: ${resolvedProfileDir}）。\n`,
        )
      }
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    if (json) {
      stdout.write(`${JSON.stringify({ event: "error", code: "start_failed", message })}\n`)
    } else {
      stderr.write(`启动 Pigcode Host 失败: ${message}\n`)
    }
    return 1
  } finally {
    signalSource.off("SIGINT", onSigInt)
    signalSource.off("SIGTERM", onSigTerm)
  }
}

async function runStatus(
  profileDir: string,
  json: boolean,
  stdout: WritableStreamLike,
  stderr: WritableStreamLike,
): Promise<number> {
  const resolved = resolve(profileDir)
  const meta = await probeLiveHost(resolved)
  if (meta) {
    try {
      const status = await callAdminSocket(meta.socketPath, "host.status", {})
      if (json) stdout.write(`${JSON.stringify({ running: true, ...status })}\n`)
      else stdout.write(`${formatHostStatus(status)}\n`)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`无法读取运行中的 Host 状态: ${message}\n`)
      return 1
    }
  }

  const summary = readOfflineSummary(resolved)
  if (json) {
    stdout.write(
      `${JSON.stringify({
        running: false,
        profileDir: resolved,
        relay: summary.relay,
        pairedDevices: summary.devices.length,
      })}\n`,
    )
  } else {
    stdout.write(`${formatOfflineStatus(resolved, summary.relay, summary.devices.length)}\n`)
  }
  return 1
}

/** 运行 `pigcode-host` CLI；返回进程退出码。 */
export async function runHeadlessCli(argv: string[], deps: HeadlessCliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const stdin = deps.stdin ?? (process.stdin as ReadableInputLike)
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? homedir()
  const signalSource = deps.signalSource ?? process
  const forceExit = deps.forceExit ?? ((code: number) => process.exit(code))
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_PAIR_POLL_MS

  const parsed = parseHeadlessCliArgs(argv)
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n`)
    return 2
  }

  const { global, command } = parsed
  if (command.kind === "help") {
    stdout.write(`${formatHelpText()}\n`)
    return 0
  }

  if (command.kind === "dump-config") {
    return runDumpConfig(global, stdout, env, platform, home, deps.defaultDumpProfileDir)
  }

  const profileDir = resolveProfileDir({
    cliProfileDir: global.profileDir,
    env,
    platform,
    home,
  })

  switch (command.kind) {
    case "start":
      return runStart(
        profileDir,
        global.profileName,
        command.lanPort,
        command.noShellEnv,
        global.json,
        {
          stdout,
          stderr,
          env,
          platform,
          home,
          signalSource,
          forceExit,
          applyShellEnv: deps.applyLoginShellEnv,
        },
      )
    case "status":
      return runStatus(profileDir, global.json, stdout, stderr)
    case "relay-status":
    case "relay-set":
    case "relay-clear":
      return runRelayCommand(command, profileDir, global.json, {
        stdout,
        stderr,
        stdin,
        env,
        readHiddenInput: deps.readHiddenInput,
        relayProbe: deps.relayProbe,
      })
    case "pair":
      return runPairCommand({
        profileDir,
        showRaw: command.showRaw,
        json: global.json,
        stdout,
        stderr,
        stdin,
        signalSource,
        pollIntervalMs,
        confirmPrompt: deps.confirmPrompt,
      })
    case "devices":
      return runDevicesCommand(profileDir, global.json, stdout, stderr)
    case "revoke":
      return runRevokeCommand(command.idOrPrefix, command.yes, profileDir, global.json, {
        stdout,
        stderr,
        stdin,
        env,
        confirmPrompt: deps.confirmPrompt,
      })
  }
}
