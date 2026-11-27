/**
 * Host 公共引导层：解析运行时 profile、初始化核心服务与插件、挂载手机连接与定时任务，
 * 供 Electron utilityProcess 与无窗口常驻进程共用。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "cordis"
import type { HostReminder } from "@pigcode/contracts"
import { sweepOrphanedProcesses } from "@pigcode/plugin-sdk/node"
import { MobileConnections, type MobileConnectionsOptions } from "../mobile/connections"
import { attachHostReminders } from "../rpc/host-reminders"
import { ThreadFeed } from "../rpc/thread-feed"
import { createLocalCredentialCipher } from "../services/local-credential"
import { apply as pluginsPlugin } from "../services/plugins"
import { RelaySettings } from "../services/relay-settings"
import { createHostAppFromProfile, requireCoreService } from "./app"
import { writeBootGraph } from "./boot"
import { loadProfile } from "./profile"
import { ensureProfileDir } from "./profile-paths"

/** `bootstrapHostKernel` 的启动参数。 */
export interface BootstrapHostOptions {
  profileDir: string
  profileName?: string | undefined
  runtimeRoot?: string | undefined
  lanPort?: MobileConnectionsOptions["lanPort"] | undefined
  onReminder?: ((reminder: HostReminder) => void) | undefined
}

/** 已完成引导的 Host 内核实例与幂等释放入口。 */
export interface BootstrappedHost {
  profileDir: string
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
  if (override) return override
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
 * 引导 Host 内核：准备用户 profile 目录、清理遗留进程、加载核心服务与插件、
 * 初始化本机凭据加密、中继设置、手机端连接与定时任务。
 */
export async function bootstrapHostKernel(
  options: BootstrapHostOptions,
): Promise<BootstrappedHost> {
  const {
    profileDir,
    profileName = "desktop",
    runtimeRoot = resolveHostRuntimeRoot(),
    lanPort = DEFAULT_LAN_PORT,
    onReminder,
  } = options

  ensureProfileDir(profileDir)
  // 上一个 Host 崩溃时留下的 Agent 进程在这里收拾掉，之后才启动新的会话。
  await sweepOrphanedProcesses()
  const profile = await loadProfile(runtimeRoot, profileName)
  const ctx = await createHostAppFromProfile(profile, {
    "core.storage": { path: process.env.PIGCODE_DB_PATH ?? join(profileDir, "pigcode.db") },
    "core.settings": { path: join(profileDir, "settings.json") },
    "core.agents": {
      fake: process.env.PIGCODE_AGENT === "fake",
      dataDir: join(profileDir, "agents"),
    },
  })

  try {
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
    await ctx.plugin(pluginsPlugin, { profileDir, builtin: profile.builtinPlugins })
    await ctx.plugins.loadAll()
    // Host 入口加载失败的插件也不加载界面代码；它的错误显示在插件页。
    await writeBootGraph(
      { profileDir, builtin: profile.builtinPlugins },
      ctx.plugins.hostFailures(),
    )

    const feed = new ThreadFeed(ctx)
    if (onReminder) attachHostReminders(ctx, onReminder)

    const cipher = createLocalCredentialCipher(profileDir)
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

    let disposing: Promise<void> | undefined
    const dispose = (reason?: "exited" | "restarting"): Promise<void> => {
      disposing ??= (async () => {
        if (reason) {
          mobile.announceExit(reason)
          await new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_DELAY_MS))
        }
        disposeMobile()
        await ctx.fiber.dispose()
      })()
      return disposing
    }

    return { profileDir, ctx, feed, relay, mobile, dispose }
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined)
    throw error
  }
}
