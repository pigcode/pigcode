/** Host utilityProcess 入口：接收 main 转交的端口并启动 RPC。 */
import { createHostApp } from "./kernel/app"
import { writeBootGraph } from "./kernel/boot"
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
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

if (!parentPort) {
  throw new Error("host entry must run inside an Electron utilityProcess")
}

parentPort.on("message", (event) => {
  void bootstrap(event)
})

/** 收到端口后创建 kernel，并在应用端口上启动 RPC。 */
async function bootstrap(event: ParentPortMessageEvent): Promise<void> {
  if (event.data?.type !== "ports") return
  const [control, appPort] = event.ports
  if (!appPort) return
  const profileDir = process.env.PIGCODE_PROFILE_DIR
  if (!profileDir) throw new Error("PIGCODE_PROFILE_DIR is required")
  const ctx = await createHostApp({ profileDir, profileName: "desktop" })
  await ctx.plugin(pluginsPlugin, { profileDir })
  await writeBootGraph(profileDir)
  new RpcServer(ctx, new MessagePortTransport(appPort)).start()
  control?.on("message", () => {})
}
