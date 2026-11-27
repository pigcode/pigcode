/**
 * Renderer 入口：等待 MessagePort，建立连接，挂载 React 应用。
 *
 * 共享模块（ADR-0002）在其余 import 之前先就位：宿主从这里初始化 React 与 ui-primitives，后面加载的
 * 插件按包名 import 到的就是这两个实例。模块的副作用在第一次 import 时完成，顺序由这条 import 保证。
 */
import "./shared"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import {
  AppStore,
  Connection,
  HostPool,
  LocaleController,
  ExtensionRegistryScope,
  createExtensionRegistry,
  type HostTransport,
} from "@pigcode/client-runtime"
import { HOST_LOCAL_ID, hostIdentitySchema } from "@pigcode/contracts"
import "@pigcode/ui-primitives/styles/globals.css"
import { App } from "./app"
import { registerBuiltinSettingsPages } from "./builtin-settings-pages"
import { registerBuiltinSurfaces } from "./builtin-surfaces"
import { registerBuiltinToolRenderers, ToolRenderersScope } from "./builtin-tool-renderers"
import { createClientPluginController } from "./client-plugins"

/** 全局状态、连接、扩展点注册表与插件控制器在模块加载时创建一次。 */
const store = new AppStore()
const extensions = createExtensionRegistry()
registerBuiltinSurfaces(extensions)
registerBuiltinToolRenderers(extensions)
const locale = new LocaleController()

const savedLocale = window.localStorage.getItem("pigcode.locale")
if (savedLocale === "zh-CN" || savedLocale === "en-US") locale.setLocale(savedLocale)
// 根元素的 lang 选对中日文字形，也是 UI 插件读取界面语言的地方。
document.documentElement.lang = locale.getLocale()

const connection = new Connection({
  onEvent: (event) => store.addEvent(event),
  // 打开长会话时整段历史一次写入，只触发一次渲染；写完也就知道这个会话还有没有消息。
  onEvents: (events, threadId) => store.addEvents(events, threadId),
  // 流式增量按帧合并写入；新事件到达前 store 会先写完已排队的文本。
  onDelta: (delta) => {
    if (delta.event.type === "message.delta") {
      store.queueDelta(delta.threadId, delta.event.text)
    } else if (delta.event.type === "tool.outputDelta") {
      store.queueToolOutput(delta.threadId, delta.event.toolCallId, delta.event.delta)
    } else if (delta.event.type === "reasoning.delta") {
      store.queueReasoning(delta.threadId, delta.event.text)
    }
  },
  onStatus: (status) =>
    store.update(
      status === "connected"
        ? { status, connectionRevision: connection.connectionRevision }
        : { status },
    ),
  onLiveSnapshot: (threadId, live) => store.restoreLiveRun(threadId, live),
  onScheduledThread: (thread) => {
    const { threads } = store.getSnapshot()
    if (!threads.some((item) => item.id === thread.id))
      store.update({ threads: [thread, ...threads] })
  },
  onThreadChanged: (thread) => store.upsertThread(thread),
  onProjectsChanged: (projects) => store.update({ projects }),
})

const plugins = createClientPluginController({ extensions, connection })
const hostPool = new HostPool({ localConnection: connection, localStore: store })
registerBuiltinSettingsPages(extensions, { connection, store, plugins })

let attached = false

function createPortTransport(port: MessagePort): HostTransport {
  port.start()
  return {
    send: (message) => port.postMessage(message),
    onMessage: (listener) => {
      const handler = (event: MessageEvent) => listener(event.data)
      port.addEventListener("message", handler)
      return () => port.removeEventListener("message", handler)
    },
    close: () => port.close(),
  }
}

/** 绑定 Host 转交的 MessagePort；重连时保留 cursor 并更新提示状态。 */
async function attach(port: MessagePort): Promise<void> {
  if (attached) store.update({ reconnected: false })
  try {
    // 新端口可能连续到达：被后来的一次取代时 attach 返回 false，不能当成连接成功。
    const connected = await connection.attach(createPortTransport(port))
    if (!connected) return
  } catch {
    store.update({ status: "offline" })
    return
  }
  if (attached) store.update({ reconnected: true })
  attached = true
  // 同步本机主机公钥、名称与定时任务快照，防止自配对并提供多主机基础清单。
  void connection
    .call("host.identity", {})
    .then((raw) => {
      const identity = hostIdentitySchema.parse(raw)
      hostPool.setLocalIdentity({ hostKey: identity.hostKey, hostName: identity.hostName })
      window.pigcodeNative?.hosts?.setLocalKey(identity.hostKey)
    })
    .catch(() => undefined)
  void hostPool.refreshHostSchedules(HOST_LOCAL_ID)
  // Host 就绪后读取 boot graph；失败时核心 UI 不受影响。
  void plugins.reload()
}

const nativeHosts = window.pigcodeNative?.hosts
if (nativeHosts) {
  void nativeHosts
    .getState()
    .then(({ hosts, defaults, pairing }) => {
      hostPool.syncRemoteHosts(hosts, defaults)
      hostPool.setPairingState(pairing)
    })
    .catch(() => undefined)
  nativeHosts.onHostsChanged(({ hosts, defaults }) => {
    hostPool.syncRemoteHosts(hosts, defaults)
  })
  nativeHosts.onPairingChanged((pairing) => {
    hostPool.setPairingState(pairing)
  })
}

window.addEventListener("message", (event) => {
  if (event.data?.type === "pigcode:port") {
    const port = event.ports[0]
    if (port) void attach(port)
    return
  }
  if (event.data?.type === "pigcode:remote-port") {
    const hostId = typeof event.data.hostId === "string" ? event.data.hostId : null
    const port = event.ports[0]
    if (hostId && port) {
      void hostPool.attachRemoteTransport(hostId, createPortTransport(port))
    }
  }
})

const root = document.querySelector("#root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      {/* Panel、Surface、设置页、Command 与工具渲染器从扩展点注册表读取。 */}
      <ExtensionRegistryScope registry={extensions}>
        <ToolRenderersScope>
          <App
            store={store}
            connection={connection}
            plugins={plugins}
            hostPool={hostPool}
            locale={locale.getLocale()}
          />
        </ToolRenderersScope>
      </ExtensionRegistryScope>
    </StrictMode>,
  )
}
