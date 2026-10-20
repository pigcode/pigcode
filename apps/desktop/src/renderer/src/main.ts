/** M0-A 调试渲染器：验证 MessagePort、项目/线程、fake 流、重连和插件面板。 */
import { RpcClient, type HostTransport } from "@pigcode/client-runtime"

/** 当前项目、线程与线程事件游标；重连时从 cursor 继续订阅。 */
const state: { projectId?: string; threadId?: string; cursor: number } = { cursor: 0 }
let client: RpcClient | undefined

window.addEventListener("message", (event) => {
  if (event.data?.type !== "pigcode:port") return
  const port = event.ports[0]
  if (!port) return
  void connect(port)
})

/** 用新端口建立 RPC 连接；已有线程时从 cursor 重订阅并标记重连。 */
async function connect(port: MessagePort): Promise<void> {
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
  client.onNotification((message) => {
    const value = message as { method?: string; params?: { seq?: number } }
    if (value.method === "thread.delta") {
      renderEvents([value.params])
      return
    }
    if (value.method === "thread.event" && value.params) {
      state.cursor = Math.max(state.cursor, value.params.seq ?? state.cursor)
      renderEvents([value.params])
    }
  })
  if (state.threadId) {
    const subscription = await call("thread.subscribe", {
      threadId: state.threadId,
      cursor: state.cursor,
    })
    renderStoredEvents((subscription as { events: unknown[] }).events)
    appendStatus("reconnected")
  }
  await loadPlugins()
}

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

/** 通过当前连接发起 RPC 调用；连接建立前显式失败。 */
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
  state.cursor = 0
  const subscription = await call("thread.subscribe", { threadId: thread.id, cursor: 0 })
  renderStoredEvents((subscription as { events: unknown[] }).events)
})

document.querySelector("#send")!.addEventListener("click", async () => {
  if (!state.threadId) return
  const text = (document.querySelector("#text") as HTMLInputElement).value
  await call("run.start", { threadId: state.threadId, text })
})

/** 把已持久化事件渲染到消息区，并把 cursor 推进到最大 seq。 */
function renderStoredEvents(events: unknown[]): void {
  for (const event of events) {
    const seq = (event as { seq?: number }).seq
    if (typeof seq === "number") state.cursor = Math.max(state.cursor, seq)
  }
  renderEvents(events)
}

/** 在消息区追加一条连接状态。 */
function appendStatus(text: string): void {
  const row = document.createElement("div")
  row.className = "event"
  row.textContent = text
  document.querySelector("#messages")!.append(row)
}

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
