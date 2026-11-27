/** Host utilityProcess 入口：接收 main 转交的端口，引导公共内核并挂载桌面适配层。 */
import {
  bootstrapHostKernel,
  resolveHostRuntimeRoot,
  type BootstrappedHost,
} from "./kernel/bootstrap"
import { MessagePortTransport, type HostMessagePort } from "./rpc/message-port-transport"
import { PageTransport } from "./rpc/page-transport"
import { RpcServer } from "./rpc/server"
import { attachQuitState } from "./rpc/quit-state"
import { attachHostActivity } from "./rpc/host-activity"
import { desktopAttachmentThumbnailer } from "./services/attachment-thumbnail"

/** utilityProcess 注入的 parentPort 事件形状。 */
interface ParentPortMessageEvent {
  data?: { type?: string; reason?: string; suspended?: boolean }
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

/** 已经引导完成的 Host 实例；退出时通过 dispose() 运行清理。 */
let host: BootstrappedHost | undefined
let bootstrapping: Promise<void> | undefined
let stopPromise: Promise<void> | undefined
let stopReason: "exited" | "restarting" | undefined
let suspended = false

/** 页面连接；页面每次加载（包括刷新）main 都会新开一条，换上以后 RPC 服务不变。 */
const page = new PageTransport()
/** 启动完成后的 RPC 服务；在这之前送来的页面连接先等着。 */
let rpc: RpcServer | undefined
/** Host 还在启动时送来的页面连接。 */
let waitingPage: HostMessagePort | undefined

/** 接上页面的新连接，释放旧页面的订阅。 */
function servePage(port: HostMessagePort): void {
  if (!rpc) {
    waitingPage?.close()
    waitingPage = port
    return
  }
  rpc.releasePage()
  page.attach(new MessagePortTransport(port))
}

function closeEventPorts(ports: readonly HostMessagePort[]): void {
  for (const port of ports) port.close()
}

parentPort.on("message", (event) => {
  if (event.data?.type === "shutdown") {
    const reason = event.data.reason === "restarting" ? "restarting" : "exited"
    void shutdown(reason)
    return
  }
  if (stopPromise) {
    closeEventPorts(event.ports)
    return
  }
  if (event.data?.type === "power" && typeof event.data.suspended === "boolean") {
    suspended = event.data.suspended
    host?.mobile.setSuspended(suspended)
    return
  }
  if (event.data?.type === "page") {
    const port = event.ports[0]
    if (port) servePage(port)
    return
  }
  if (event.data?.type !== "ports" || bootstrapping) {
    closeEventPorts(event.ports)
    return
  }
  bootstrapping = bootstrap(event).catch(async (error: unknown) => {
    if (stopPromise) return
    // 启动失败要留下原因再退出；静默的未处理拒绝无从排查。原因同时交给 main：连续失败时 main 停止重启，
    // 把它显示在错误对话框里。稍等一下再退出，让这条消息送到 main。
    console.error("[host] bootstrap failed:", error)
    rpc?.stop()
    rpc = undefined
    waitingPage?.close()
    waitingPage = undefined
    await host?.dispose().catch(() => undefined)
    if (stopPromise) return
    const message = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({ type: "fatal", message })
    setTimeout(() => process.exit(1), 200)
  })
})

/** main 要退出了：运行清理，结束 Agent 和终端的进程树，然后退出。卡住时 main 会强制结束本进程。 */
async function shutdown(reason: "exited" | "restarting"): Promise<void> {
  stopReason ??= reason
  stopPromise ??= (async () => {
    try {
      await bootstrapping?.catch(() => undefined)
      waitingPage?.close()
      waitingPage = undefined
      rpc?.stop()
      rpc = undefined
      await host?.dispose(reason)
    } catch (error) {
      console.error("[host] shutdown failed:", error)
    }
    process.exit(0)
  })()
  await stopPromise
}

/** 收到控制端口后引导 kernel；完成后接上已经在等的页面连接与桌面控制通道。 */
async function bootstrap(event: ParentPortMessageEvent): Promise<void> {
  const [control] = event.ports
  const profileDir = process.env.PIGCODE_PROFILE_DIR?.trim()
  if (!profileDir) throw new Error("PIGCODE_PROFILE_DIR is required")

  const bootstrapped = await bootstrapHostKernel({
    profileDir,
    profileName: "desktop",
    runtimeRoot: resolveHostRuntimeRoot(import.meta.url),
    ...(control
      ? { onReminder: (reminder) => control.postMessage({ type: "host.reminder", reminder }) }
      : {}),
  })
  if (stopPromise) {
    waitingPage?.close()
    waitingPage = undefined
    await bootstrapped.dispose(stopReason).catch(() => undefined)
    return
  }

  host = bootstrapped
  bootstrapped.mobile.setSuspended(suspended)

  const { ctx, feed } = bootstrapped
  if (control) {
    const controlTransport = new MessagePortTransport(control)
    ctx.get("attachments")?.setThumbnailer(desktopAttachmentThumbnailer(controlTransport))
  }

  rpc = new RpcServer(ctx, page, feed)
  rpc.start()
  if (waitingPage) {
    servePage(waitingPage)
    waitingPage = undefined
  }

  // 控制端口承载内置浏览器动作、退出检查、本机预览地址同步和桌面的电源管理。
  if (control) {
    ctx.get("browser")?.attach(control)
    ctx.get("mobilePreview")?.attach(control)
    attachQuitState(control, ctx)
    attachHostActivity(control, ctx)
  }
}
