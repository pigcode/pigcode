/** Renderer 入口：等待 MessagePort，建立连接，挂载 React 应用。 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AppStore, Connection, LocaleController, createSlotRegistry } from "@pigcode/client-runtime"
import "@pigcode/ui-primitives/styles/globals.css"
import { App } from "./app"
import { createClientPluginController } from "./client-plugins"
import { registerCorePlugins } from "./core-plugins"

/** 全局状态、连接、slot 与插件控制器在模块加载时创建一次。 */
const store = new AppStore()
const slots = createSlotRegistry()
const locale = new LocaleController()

const savedLocale = window.localStorage.getItem("pigcode.locale")
if (savedLocale === "zh-CN" || savedLocale === "en-US") locale.setLocale(savedLocale)

const connection = new Connection({
  onEvent: (event) => store.addEvent(event),
  onDelta: (delta) => {
    if (delta.event.type === "message.delta") {
      store.appendDelta(delta.threadId, delta.event.text)
    }
  },
  onStatus: (status) => store.update({ status }),
})

const plugins = createClientPluginController({ slots, connection })
registerCorePlugins(slots, { connection, store, plugins })

let attached = false

/** 绑定 Host 转交的 MessagePort；重连时保留 cursor 并更新提示状态。 */
async function attach(port: MessagePort): Promise<void> {
  port.start()
  if (attached) store.update({ reconnected: false })
  try {
    await connection.attach({
      send: (message) => port.postMessage(message),
      onMessage: (listener) => {
        const handler = (event: MessageEvent) => listener(event.data)
        port.addEventListener("message", handler)
        return () => port.removeEventListener("message", handler)
      },
      close: () => port.close(),
    })
  } catch {
    store.update({ status: "offline" })
    return
  }
  if (attached) store.update({ reconnected: true })
  attached = true
  // Host 就绪后读取 boot graph；失败时核心 UI 不受影响。
  void plugins.reload()
}

window.addEventListener("message", (event) => {
  if (event.data?.type !== "pigcode:port") return
  const port = event.ports[0]
  if (!port) return
  void attach(port)
})

const root = document.querySelector("#root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        store={store}
        slots={slots}
        connection={connection}
        plugins={plugins}
        locale={locale.getLocale()}
      />
    </StrictMode>,
  )
}
