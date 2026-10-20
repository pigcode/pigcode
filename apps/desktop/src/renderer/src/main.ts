/** M0-A 调试渲染器：验证 MessagePort、项目/线程、fake 流和插件面板。 */
import { RpcClient, type HostTransport } from "@pigcode/client-runtime"

const state: { projectId?: string; threadId?: string } = {}
let client: RpcClient | undefined

window.addEventListener("message", async (event) => {
  if (event.data?.type !== "pigcode:port") return
  const port = event.ports[0]
  if (!port) return
  port.start()
  const transport: HostTransport = {
    send: (message: unknown) => port.postMessage(message),
    onMessage: (listener: (message: unknown) => void) => {
      const handler = (messageEvent: MessageEvent) => listener(messageEvent.data)
      port.addEventListener("message", handler)
      return () => port.removeEventListener("message", handler)
    },
    close: () => port.close(),
  }
  client = new RpcClient(transport)
  await loadPlugins()
})

/** 读取 boot.json，并应用每个插件的 client 入口；失败不影响核心调试界面。 */
async function loadPlugins(): Promise<void> {
  try {
    const response = await fetch("pigcode-plugin://boot.json")
    if (!response.ok) return
    const boot = (await response.json()) as { entries: Array<{ id: string; url: string }> }
    for (const entry of boot.entries) {
      const pluginModule = (await import(entry.url)) as {
        apply?: (ctx: {
          registerPanel: (panel: {
            id: string
            title: string
            render(container: HTMLElement): void
          }) => () => void
        }) => void
      }
      pluginModule.apply?.({
        registerPanel(panel) {
          const host = document.querySelector("#plugin-panels")!
          const section = document.createElement("section")
          const title = document.createElement("h4")
          title.textContent = panel.title
          const body = document.createElement("div")
          section.append(title, body)
          host.append(section)
          panel.render(body)
          return () => section.remove()
        },
      })
    }
  } catch {
    // 插件加载失败不影响核心调试界面
  }
}

async function call(method: string, params: unknown): Promise<unknown> {
  if (!client) throw new Error("host not connected")
  return client.call(method, params)
}

document.querySelector("#add")!.addEventListener("click", async () => {
  const rootPath = (document.querySelector("#root") as HTMLInputElement).value
  const project = (await call("project.add", { rootPath })) as { id: string }
  state.projectId = project.id
})

document.querySelector("#new")!.addEventListener("click", async () => {
  if (!state.projectId) return
  const thread = (await call("thread.create", {
    projectId: state.projectId,
    title: "First thread",
    providerId: "fake",
  })) as { id: string }
  state.threadId = thread.id
  const subscription = await call("thread.subscribe", { threadId: thread.id, cursor: 0 })
  renderEvents((subscription as { events: unknown[] }).events)
  client?.onNotification((message) => {
    const value = message as { method?: string; params?: unknown }
    if (value.method === "thread.event" || value.method === "thread.delta") {
      renderEvents([value.params])
    }
  })
})

document.querySelector("#send")!.addEventListener("click", async () => {
  if (!state.threadId) return
  const text = (document.querySelector("#text") as HTMLInputElement).value
  await call("run.start", { threadId: state.threadId, text })
})

/** 把 RPC 事件按行渲染到消息区。 */
function renderEvents(events: unknown[]): void {
  const target = document.querySelector("#messages")!
  for (const event of events) {
    const row = document.createElement("div")
    row.className = "event"
    row.textContent = JSON.stringify(event)
    target.append(row)
  }
}
