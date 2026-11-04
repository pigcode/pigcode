/** Host utilityProcess 入口：接收 main 转交的端口并启动 RPC。 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHostAppFromProfile, requireCoreService } from "./kernel/app"
import { writeBootGraph } from "./kernel/boot"
import { loadProfile } from "./kernel/profile"
import { MessagePortTransport, type HostMessagePort } from "./rpc/message-port-transport"
import { RpcServer } from "./rpc/server"
import { apply as pluginsPlugin } from "./services/plugins"

/** utilityProcess 注入的 parentPort 事件形状。 */
interface ParentPortMessageEvent {
  data?: { type?: string }
  ports: HostMessagePort[]
}

/** parentPort 的最小接口，避免 Host 依赖 Electron 类型。 */
interface ParentPortLike {
  on(event: "message", listener: (event: ParentPortMessageEvent) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

if (!parentPort) {
  throw new Error("host entry must run inside an Electron utilityProcess")
}

parentPort.on("message", (event) => {
  void bootstrap(event).catch((error: unknown) => {
    // 启动失败要留下原因再退出；静默的未处理拒绝无从排查。原因同时交给 main：连续失败时 main 停止重启，
    // 把它显示在错误对话框里。稍等一下再退出，让这条消息送到 main。
    console.error("[host] bootstrap failed:", error)
    const message = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({ type: "fatal", message })
    setTimeout(() => process.exit(1), 200)
  })
})

/**
 * 两个目录：核心 profile 随应用发布、只读，列出核心服务与内置插件（与本文件同在 out/host 下）；
 * 用户 profile 由 main 通过 PIGCODE_PROFILE_DIR 传入，存放安装的插件、设置与数据库。
 */
function coreProfileDir(): string {
  return (
    process.env.PIGCODE_CORE_PROFILE_DIR ?? fileURLToPath(new URL("./profile", import.meta.url))
  )
}

/** 收到端口后创建 kernel，并在应用端口上启动 RPC。 */
async function bootstrap(event: ParentPortMessageEvent): Promise<void> {
  if (event.data?.type !== "ports") return
  const [control, appPort] = event.ports
  if (!appPort) return
  const profileDir = process.env.PIGCODE_PROFILE_DIR
  if (!profileDir) throw new Error("PIGCODE_PROFILE_DIR is required")
  const profile = await loadProfile(coreProfileDir(), "desktop")
  const ctx = await createHostAppFromProfile(profile, {
    "core.storage": { path: process.env.PIGCODE_DB_PATH ?? join(profileDir, "pigcode.db") },
    "core.settings": { path: join(profileDir, "settings.json") },
  })
  // 数据库打不开（备份或迁移失败、数据库比应用新）时 storage 不会起来，其后的服务也都缺席；
  // 在这里带着真正的原因失败，而不是等到下面 ctx.agents 报 TypeError。
  await requireCoreService(ctx, "core.storage", "storage")
  await requireCoreService(ctx, "core.agents", "agents")
  // 上一个 Host 进程遗留的审批与运行状态在新进程启动时统一失效。
  ctx.agents.recoverAfterRestart()
  // agent 都是插件；要在补跑定时任务之前注册好，否则过期任务找不到 Agent。
  await ctx.plugin(pluginsPlugin, { profileDir, builtin: profile.builtinPlugins })
  await ctx.plugins.loadAll()
  // Host 入口加载失败的插件也不加载界面代码；它的错误显示在插件页。
  await writeBootGraph({ profileDir, builtin: profile.builtinPlugins }, ctx.plugins.hostFailures())
  // 恢复持久化的定时任务；过期的任务在启动后补跑一次。
  ctx.get("schedules")?.start()
  new RpcServer(ctx, new MessagePortTransport(appPort)).start()
  // 控制端口目前只承载内置浏览器的动作：agent 的 browser_* 工具经它交给 main 执行。
  if (control) ctx.get("browser")?.attach(control)
}
