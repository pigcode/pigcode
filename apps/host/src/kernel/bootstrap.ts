/**
 * Host 公共引导层：解析运行时 profile、抢占单实例锁、初始化核心服务与插件、
 * 挂载手机连接、定时任务与本机控制通道，供 Electron utilityProcess 与无窗口常驻进程共用。
 */
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "cordis"
import type { HostReminder, HostRuntimeKind } from "@pigcode/contracts"
import { HOST_VERSION } from "@pigcode/plugin-sdk"
import { sweepOrphanedProcesses } from "@pigcode/plugin-sdk/node"
import { MobileConnections, type MobileConnectionsOptions } from "../mobile/connections"
import { attachHostReminders } from "../rpc/host-reminders"
import { readQuitState } from "../rpc/quit-state"
import { ThreadFeed } from "../rpc/thread-feed"
import { createLocalCredentialCipher } from "../services/local-credential"
import { apply as pluginsPlugin } from "../services/plugins"
import { RelaySettings } from "../services/relay-settings"
import { AdminHandlerError, startAdminSocketServer, type AdminSocketServer } from "./admin-socket"
import { createHostAppFromProfile, requireCoreService } from "./app"
import { writeBootGraph } from "./boot"
import { acquireHostLock, hostControlEndpoint, type HostLockHandle } from "./host-lock"
import { loadProfile } from "./profile"
import { ensureProfileDir } from "./profile-paths"

/** `bootstrapHostKernel` 的启动参数。 */
export interface BootstrapHostOptions {
  profileDir: string
  profileName?: string | undefined
  runtime?: HostRuntimeKind | undefined
  instanceLock?: boolean | undefined
  adminServer?: boolean | undefined
  onStopRequested?: ((reason: "exited" | "restarting") => void) | undefined
  runtimeRoot?: string | undefined
  lanPort?: MobileConnectionsOptions["lanPort"] | undefined
  onReminder?: ((reminder: HostReminder) => void) | undefined
}

/** 已完成引导的 Host 内核实例与幂等释放入口。 */
export interface BootstrappedHost {
  profileDir: string
  runtime: HostRuntimeKind
  socketPath: string
  ctx: Context
  feed: ThreadFeed
  relay: RelaySettings
  mobile: MobileConnections
  dispose(reason?: "exited" | "restarting"): Promise<void>
}

/** 退出前等待退场通知帧刷出的短缓冲（毫秒）。 */
const EXIT_FLUSH_DELAY_MS = 80
/** 手机局域网直连默认监听端口。 */
const DEFAULT_LAN_PORT = 39871

/**
 * 定位随应用发布的核心 profile 目录（含 `desktop.yml`）。
 * 优先读取 `PIGCODE_CORE_PROFILE_DIR`，否则按打包产物与源码目录依次探测。
 */
export function resolveHostRuntimeRoot(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.PIGCODE_CORE_PROFILE_DIR?.trim()
  if (override) return resolve(override)
  const candidates = [
    fileURLToPath(new URL("./profile", moduleUrl)),
    fileURLToPath(new URL("../../desktop/out/host/profile", moduleUrl)),
    fileURLToPath(new URL("../../../desktop/out/host/profile", moduleUrl)),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, "desktop.yml"))) return dir
  }
  return candidates[0]!
}

/**
 * 引导 Host 内核：先抢占单实例锁，再准备用户 profile 目录、清理遗留进程、
 * 加载核心服务与插件、初始化本机凭据加密、中继设置、手机端连接、定时任务及控制通道。
 */
export async function bootstrapHostKernel(
  options: BootstrapHostOptions,
): Promise<BootstrappedHost> {
  const {
    profileDir,
    profileName = "desktop",
    runtime = "headless",
    instanceLock = true,
    adminServer = true,
    onStopRequested,
    runtimeRoot = resolveHostRuntimeRoot(),
    lanPort = DEFAULT_LAN_PORT,
    onReminder,
  } = options

  const resolvedProfileDir = resolve(profileDir)
  const socketPath = hostControlEndpoint(resolvedProfileDir)
  const previousProfileDirEnv = process.env.PIGCODE_PROFILE_DIR
  let envSet = false
  let envRestored = false
  const restoreProfileDirEnv = (): void => {
    if (!envSet || envRestored) return
    envRestored = true
    if (previousProfileDirEnv === undefined) {
      delete process.env.PIGCODE_PROFILE_DIR
    } else {
      process.env.PIGCODE_PROFILE_DIR = previousProfileDirEnv
    }
  }

  let lock: HostLockHandle | undefined
  let admin: AdminSocketServer | undefined
  let ctx: Context | undefined

  try {
    if (instanceLock) {
      lock = await acquireHostLock(resolvedProfileDir, {
        runtime,
        version: HOST_VERSION,
        socketPath,
      })
    } else {
      ensureProfileDir(resolvedProfileDir)
    }

    const startedAt = lock?.metadata.startedAt ?? Date.now()
    // 拿到单实例锁后再设置环境变量、清理孤儿进程与打开 SQLite，避免竞争进程互相干扰。
    process.env.PIGCODE_PROFILE_DIR = resolvedProfileDir
    envSet = true

    // 上一个 Host 崩溃时留下的 Agent 进程在这里收拾掉，之后才启动新的会话。
    await sweepOrphanedProcesses()
    const profile = await loadProfile(runtimeRoot, profileName)
    ctx = await createHostAppFromProfile(profile, {
      "core.storage": {
        path: process.env.PIGCODE_DB_PATH ?? join(resolvedProfileDir, "pigcode.db"),
      },
      "core.settings": { path: join(resolvedProfileDir, "settings.json") },
      "core.agents": {
        fake: process.env.PIGCODE_AGENT === "fake",
        dataDir: join(resolvedProfileDir, "agents"),
      },
    })

    // 核心服务缺席时在这里带着真正的原因失败，而不是等到后面报 TypeError。
    await requireCoreService(ctx, "core.storage", "storage")
    await requireCoreService(ctx, "core.settings", "settings")
    await requireCoreService(ctx, "core.projects", "projects")
    await requireCoreService(ctx, "core.threads", "threads")
    await requireCoreService(ctx, "core.sessions", "sessions")
    await requireCoreService(ctx, "core.attachments", "attachments")
    await requireCoreService(ctx, "core.agents", "agents")

    // 上一个 Host 进程遗留的审批与运行状态在新进程启动时统一失效。
    await ctx.agents.recoverAfterRestart()
    // agent 都是插件；要在补跑定时任务之前注册好，否则过期任务找不到 Agent。
    await ctx.plugin(pluginsPlugin, {
      profileDir: resolvedProfileDir,
      builtin: profile.builtinPlugins,
    })
    await ctx.plugins.loadAll()
    // Host 入口加载失败的插件也不加载界面代码；它的错误显示在插件页。
    await writeBootGraph(
      { profileDir: resolvedProfileDir, builtin: profile.builtinPlugins },
      ctx.plugins.hostFailures(),
    )

    const feed = new ThreadFeed(ctx)
    if (onReminder) attachHostReminders(ctx, onReminder)

    const cipher = createLocalCredentialCipher(resolvedProfileDir)
    const relay = new RelaySettings(ctx.settings, cipher)
    ctx.provide("relaySettings", relay)

    const mobile = new MobileConnections(ctx, relay, cipher, feed, { lanPort })
    ctx.provide("mobileConnections", mobile)
    let mobileDisposed = false
    const disposeMobile = (): void => {
      if (mobileDisposed) return
      mobileDisposed = true
      mobile.dispose()
    }
    ctx.effect(() => disposeMobile)

    // 装好提醒订阅后再恢复定时任务，过期任务也使用相同的提醒事件。
    await ctx.get("schedules")?.start()

    const bootedCtx = ctx
    if (adminServer) {
      admin = await startAdminSocketServer(lock?.socketPath ?? socketPath, {
        "host.status": async () => {
          const quitState = readQuitState(bootedCtx)
          const lanAddresses = await mobile.readyLanAddresses()
          const pairing = mobile.view()
          const desktopPairing = mobile.desktopView()
          const identity = await mobile.hostIdentity().catch(() => null)
          return {
            pid: process.pid,
            runtime,
            version: HOST_VERSION,
            profileDir: resolvedProfileDir,
            startedAt,
            relay: relay.view(),
            lanAddresses,
            activeRuns: quitState.runs,
            pendingApprovals: quitState.approvals,
            pairedDevices: pairing.devices.length,
            pairedDesktops: desktopPairing.clients.length,
            hostName: identity?.hostName ?? mobile.hostName(),
            ...(identity ? { hostKey: identity.hostKey } : {}),
          }
        },
        "host.setName": ({ name }) => ({ hostName: mobile.setHostName(name) }),
        "host.stop": ({ reason }) => {
          if (!onStopRequested) {
            throw new AdminHandlerError(
              "UNSUPPORTED_RUNTIME",
              `Host runtime "${runtime}" does not support remote stop`,
            )
          }
          const stopReason = reason ?? "exited"
          // 先把应答帧写入控制通道，下一轮事件循环再触发优雅退出。
          setImmediate(() => onStopRequested(stopReason))
          return { stopping: true as const }
        },
        "relay.view": () => relay.view(),
        "relay.testAndSave": (params) => relay.testAndSave(params),
        "relay.clear": () => relay.clear(),
        "mobile.pairing.view": () => mobile.view(),
        "mobile.pairing.start": () => mobile.start(),
        "mobile.pairing.cancel": ({ id }) => mobile.cancel(id),
        "mobile.pairing.confirm": ({ id, confirmation }) => mobile.confirm(id, confirmation),
        "mobile.devices.list": () => mobile.view().devices,
        "mobile.devices.revoke": ({ deviceId }) => mobile.revoke(deviceId),
        "desktop.pairing.view": () => mobile.desktopView(),
        "desktop.pairing.start": () => mobile.startDesktopPairing(),
        "desktop.pairing.cancel": ({ id }) => mobile.cancelDesktopPairing(id),
        "desktop.pairing.confirm": ({ id, confirmation }) =>
          mobile.confirmDesktopPairing(id, confirmation),
        "desktop.devices.list": () => mobile.desktopView().clients,
        "desktop.devices.revoke": ({ deviceId }) => mobile.revokeDesktop(deviceId),
      })
    }

    let disposing: Promise<void> | undefined
    const dispose = (reason?: "exited" | "restarting"): Promise<void> => {
      disposing ??= (async () => {
        try {
          if (reason) {
            mobile.announceExit(reason)
            await new Promise((resolveDelay) => setTimeout(resolveDelay, EXIT_FLUSH_DELAY_MS))
          }
        } finally {
          try {
            disposeMobile()
          } finally {
            try {
              await admin?.close()
            } finally {
              try {
                await bootedCtx.fiber.dispose()
              } finally {
                try {
                  lock?.release()
                } finally {
                  restoreProfileDirEnv()
                }
              }
            }
          }
        }
      })()
      return disposing
    }

    return {
      profileDir: resolvedProfileDir,
      runtime,
      socketPath: lock?.socketPath ?? socketPath,
      ctx,
      feed,
      relay,
      mobile,
      dispose,
    }
  } catch (error) {
    try {
      await admin?.close().catch(() => undefined)
    } finally {
      try {
        await ctx?.fiber.dispose().catch(() => undefined)
      } finally {
        try {
          lock?.release()
        } finally {
          restoreProfileDirEnv()
        }
      }
    }
    throw error
  }
}
