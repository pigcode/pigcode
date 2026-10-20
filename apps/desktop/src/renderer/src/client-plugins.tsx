/** 第三方 UI 插件：读取 boot graph、动态加载 client bundle，并把面板接入 React。 */
import { useSyncExternalStore, type ReactNode } from "react"
import type {
  BootGraph,
  ClientModule,
  Connection,
  SlotName,
  SlotRegistry,
} from "@pigcode/client-runtime"
import { loadClientPlugins } from "@pigcode/client-runtime"
import type { ClientPanel, ClientPluginContext } from "@pigcode/plugin-sdk"
import { useLocale } from "@pigcode/ui-primitives"
import { PluginPanelHost } from "@pigcode/ui-shell"

/** 当前 UI 宿主认识的全部 slot。 */
const SLOT_NAMES: readonly SlotName[] = [
  "sidebar.section",
  "chat.view",
  "settings.section",
  "panel.right",
  "status.bar",
]

/** 只允许插件注册到已知 slot，避免把未知名称灌进 registry。 */
function isSlotName(name: string): name is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(name)
}

/** 插件面板的只读快照与订阅入口。 */
export interface PanelRegistry {
  get(): ClientPanel[]
  subscribe(listener: () => void): () => void
}

/** Renderer 持有的第三方插件控制器。 */
export interface ClientPluginController {
  panels: PanelRegistry
  reload(): Promise<void>
  dispose(): void
}

/** 创建面板注册表；快照在注册项变化时才替换，满足 useSyncExternalStore。 */
function createPanelRegistry(): {
  registry: PanelRegistry
  add(panel: ClientPanel): () => void
  clear(): void
} {
  const panels = new Map<string, ClientPanel>()
  const listeners = new Set<() => void>()
  let snapshot: ClientPanel[] = []

  function emit(): void {
    snapshot = [...panels.values()]
    for (const listener of listeners) listener()
  }

  return {
    registry: {
      get: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    add(panel) {
      panels.set(panel.id, panel)
      emit()
      return () => {
        if (!panels.delete(panel.id)) return
        emit()
      }
    },
    clear() {
      if (panels.size === 0) return
      panels.clear()
      emit()
    },
  }
}

/**
 * 创建插件控制器。每次 reload 都会先卸载上一代模块与面板，再按 boot graph 重新应用；
 * generation 用来丢弃过期的异步结果，避免快速启停时旧模块复活。
 */
export function createClientPluginController(deps: {
  slots: SlotRegistry
  connection: Connection
}): ClientPluginController {
  const { registry: panels, add, clear } = createPanelRegistry()
  let generation = 0
  let disposers: Array<() => void> = []
  let cleanups: Array<() => void> = []

  function clearCurrent(): void {
    for (const dispose of [...disposers].reverse()) dispose()
    disposers = []
    for (const cleanup of [...cleanups].reverse()) cleanup()
    cleanups = []
  }

  function createContext(bucket: Array<() => void>): ClientPluginContext {
    return {
      slots: {
        register(name, entry) {
          if (!isSlotName(name)) return () => undefined
          const dispose = deps.slots.register(name, {
            id: entry.id,
            order: entry.order ?? 0,
            render: (props: never) => entry.render(props) as ReactNode,
          })
          bucket.push(dispose)
          return dispose
        },
      },
      host: {
        call: (method, params) => deps.connection.call(method, params),
      },
      registerPanel(panel) {
        const dispose = add(panel)
        bucket.push(dispose)
        return dispose
      },
    }
  }

  async function reload(): Promise<void> {
    const current = ++generation
    clearCurrent()
    clear()

    let boot: BootGraph
    try {
      const response = await fetch("pigcode-plugin://boot.json")
      if (!response.ok) return
      boot = (await response.json()) as BootGraph
    } catch {
      return
    }
    if (current !== generation) return

    const bucket: Array<() => void> = []
    try {
      const loaded = await loadClientPlugins({
        boot,
        // 单个插件加载失败只跳过该插件，不影响核心 UI。
        load: async (url) => {
          try {
            return (await import(/* @vite-ignore */ url)) as ClientModule
          } catch {
            return {}
          }
        },
        context: () => createContext(bucket),
      })
      if (current !== generation) {
        loaded.dispose()
        for (const cleanup of [...bucket].reverse()) cleanup()
        return
      }
      disposers.push(() => loaded.dispose())
      cleanups.push(...bucket)
    } catch {
      for (const cleanup of [...bucket].reverse()) cleanup()
    }
  }

  return {
    panels,
    reload,
    dispose() {
      generation += 1
      clearCurrent()
      clear()
    },
  }
}

/** 把已注册的第三方面板画进侧栏；没有面板时不占用空间。 */
export function PluginPanels({ controller }: { controller: ClientPluginController }) {
  const panels = useSyncExternalStore(
    controller.panels.subscribe,
    controller.panels.get,
    controller.panels.get,
  )
  const { t } = useLocale()
  if (panels.length === 0) return null
  return (
    <div className="plugin-panels" aria-label={t("plugins.title")}>
      {panels.map((panel) => (
        <section className="proj-block" key={panel.id}>
          <div className="side-label">
            <span>{panel.title}</span>
          </div>
          <PluginPanelHost panel={panel} />
        </section>
      ))}
    </div>
  )
}
