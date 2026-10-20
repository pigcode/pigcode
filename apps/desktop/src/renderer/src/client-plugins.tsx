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

/** slot 注册冲突等插件错误；id 用作快照内的稳定 key。 */
export interface PluginError {
  id: string
  pluginId: string
  message: string
}

/** 插件错误的只读快照与订阅入口。 */
export interface PluginErrorRegistry {
  get(): PluginError[]
  subscribe(listener: () => void): () => void
}

/** Renderer 持有的第三方插件控制器。 */
export interface ClientPluginController {
  panels: PanelRegistry
  /** 加载/注册时被跳过的错误，供插件管理界面按需展示。 */
  errors: PluginErrorRegistry
  reload(): Promise<void>
  dispose(): void
}

/** 创建按 key 去重的只读快照注册表；快照变化时才替换，满足 useSyncExternalStore。 */
function createSnapshotRegistry<T>(keyOf: (item: T) => string): {
  registry: { get(): T[]; subscribe(listener: () => void): () => void }
  add(item: T): () => void
  clear(): void
} {
  const items = new Map<string, T>()
  const listeners = new Set<() => void>()
  let snapshot: T[] = []

  function emit(): void {
    snapshot = [...items.values()]
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
    add(item) {
      items.set(keyOf(item), item)
      emit()
      return () => {
        if (!items.delete(keyOf(item))) return
        emit()
      }
    },
    clear() {
      if (items.size === 0) return
      items.clear()
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
  const {
    registry: panels,
    add: addPanel,
    clear: clearPanels,
  } = createSnapshotRegistry<ClientPanel>((panel) => panel.id)
  const {
    registry: errors,
    add: addError,
    clear: clearErrors,
  } = createSnapshotRegistry<PluginError>((error) => error.id)
  /** slot 条目归属：key 为 `slot:id`，用于拒绝重复注册并记录冲突双方。 */
  const slotOwners = new Map<string, { pluginId: string; token: symbol }>()
  let generation = 0
  let disposers: Array<() => void> = []
  let cleanups: Array<() => void> = []

  function clearCurrent(): void {
    for (const dispose of [...disposers].reverse()) dispose()
    disposers = []
    for (const cleanup of [...cleanups].reverse()) cleanup()
    cleanups = []
  }

  function reportError(pluginId: string, message: string): void {
    // 同样内容只保留一条；console.error 带上插件 id 便于定位。
    addError({ id: `${pluginId}:${message}`, pluginId, message })
    console.error(`[plugin:${pluginId}] ${message}`)
  }

  function createContext(pluginId: string, bucket: Array<() => void>): ClientPluginContext {
    return {
      slots: {
        register(name, entry) {
          if (!isSlotName(name)) return () => undefined
          const key = `${name}:${entry.id}`
          const owner = slotOwners.get(key)
          if (owner) {
            reportError(pluginId, `SLOT_CONFLICT: ${key} already registered by ${owner.pluginId}`)
            return () => undefined
          }
          const token = Symbol(key)
          slotOwners.set(key, { pluginId, token })
          const dispose = deps.slots.register(name, {
            id: entry.id,
            order: entry.order ?? 0,
            render: (props: never) => entry.render(props) as ReactNode,
          })
          let active = true
          // 只释放本次注册；旧 generation 的清理不能误删新注册的归属。
          const release = () => {
            if (!active) return
            active = false
            if (slotOwners.get(key)?.token !== token) return
            slotOwners.delete(key)
            dispose()
          }
          bucket.push(release)
          return release
        },
      },
      host: {
        call: (method, params) => deps.connection.call(method, params),
      },
      registerPanel(panel) {
        const dispose = addPanel(panel)
        bucket.push(dispose)
        return dispose
      },
    }
  }

  async function reload(): Promise<void> {
    const current = ++generation
    clearCurrent()
    clearPanels()
    clearErrors()

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
        context: (entry) => createContext(entry.id, bucket),
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
    errors,
    reload,
    dispose() {
      generation += 1
      clearCurrent()
      clearPanels()
      clearErrors()
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
