/**
 * 第三方 UI 插件：读取 boot graph、动态加载 client bundle，把插件的 Panel、Surface 与设置页登记到
 * 扩展点注册表（归属自动填成这个插件），并给插件一套和宿主一致的 DOM 组件、宿主的主题与语言。
 *
 * reload 先把新出现和换了版本的 bundle 都 import 完，再在同一个同步步骤里卸载、应用：
 * - 从 boot graph 消失（停用、卸载）的插件按 owner 移除全部 Contribution，打开着的 Surface 随之关闭，
 *   正在看的设置页退回通用页；
 * - 换了版本的插件先卸载旧的、再应用新的，Surface 的 id 在界面渲染前就回来了，打开的标签不受影响；
 * - 和刚卸载的插件冲突、被拒绝过的插件重新应用一次，拿到现在空出来的 id；
 * - 其余插件保持原样。import 失败的插件记一条错误、不算已加载，下次 reload 重试。
 */
import type { ReactNode } from "react"
import { Puzzle } from "lucide-react"
import type {
  BootEntry,
  BootGraph,
  ClientModule,
  Connection,
  ContributionOwner,
  ExtensionRegistry,
  SlotName,
  SlotRegistry,
} from "@pigcode/client-runtime"
import {
  applyClientPlugin,
  createUiKit,
  observeLocale,
  observeTheme,
} from "@pigcode/client-runtime"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { SettingPage } from "@pigcode/ui-primitives"
import { PluginContentHost } from "@pigcode/ui-shell"

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

/**
 * 插件在窗口里出的错；id 用作快照内的稳定 key。
 * - import：client bundle 没有加载成功（detail 是原因）；
 * - apply：apply 抛了错（detail 是原因）；
 * - slotConflict：slot 条目和另一个插件重名（detail 是 `slot:id`，owner 是先注册的插件）。
 */
export type PluginError =
  | { id: string; pluginId: string; kind: "import" | "apply"; detail: string }
  | { id: string; pluginId: string; kind: "slotConflict"; detail: string; owner: string }

/** 插件错误的只读快照与订阅入口。 */
export interface PluginErrorRegistry {
  get(): readonly PluginError[]
  subscribe(listener: () => void): () => void
}

/** Renderer 持有的第三方插件控制器。Panel、Surface 与设置页在扩展点注册表里，不在这里。 */
export interface ClientPluginController {
  /** 加载与注册时出的错，插件页按插件显示。 */
  errors: PluginErrorRegistry
  reload(): Promise<void>
  dispose(): void
}

/** 一个已经应用的插件：boot graph 里的版本、模块（重新应用时用）与卸载函数。 */
interface LoadedPlugin {
  revision: string
  module: ClientModule
  unload(): void
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 检查插件传来的 Panel、Surface 或设置页。插件可以是没有类型检查的 JS，缺了 id、标题或 render 的登记
 * 会让侧栏或搜索在用到它时出错；这里直接抛出，在 apply 里登记时就记成这个插件的界面代码错误。
 */
function checkContribution(
  api: string,
  item: { id?: unknown; title?: unknown; order?: unknown; render?: unknown },
): void {
  const problem =
    typeof item.id !== "string" || item.id === ""
      ? "id must be a non-empty string"
      : typeof item.title !== "string"
        ? "title must be a string"
        : typeof item.render !== "function"
          ? "render must be a function"
          : item.order !== undefined && !Number.isFinite(item.order)
            ? "order must be a number"
            : null
  if (problem) throw new TypeError(`${api}.register: ${problem}`)
}

/** 去掉 PluginError 的 id 字段，用来描述一条要记的错误。 */
type ErrorInput = PluginError extends infer E
  ? E extends PluginError
    ? Omit<E, "id">
    : never
  : never

/** 创建插件控制器。 */
export function createClientPluginController(deps: {
  slots: SlotRegistry
  extensions: ExtensionRegistry
  connection: Connection
  /** 加载 client bundle；测试里替换。 */
  importModule?: (url: string) => Promise<ClientModule>
}): ClientPluginController {
  const importModule =
    deps.importModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<ClientModule>)
  let errors: readonly PluginError[] = []
  const errorListeners = new Set<() => void>()
  // 插件拿到的组件、主题与语言都只读宿主的根元素，所有插件共用一份。
  const ui = createUiKit()
  const theme = observeTheme()
  const locale = observeLocale()
  /** slot 条目归属：key 为 `slot:id`，用于拒绝重复注册并记录冲突双方。 */
  const slotOwners = new Map<string, { pluginId: string; token: symbol }>()
  const loaded = new Map<string, LoadedPlugin>()
  /** 每次 reload 领一个号；只有拿到 boot graph、而且比已经拿到的都新的那次才会继续。 */
  let requested = 0
  /** 正在生效的 reload 的号；更新的 reload 拿到 boot graph（或 dispose）后，旧的在下一个 await 处停下。 */
  let generation = 0

  function setErrors(next: readonly PluginError[]): void {
    errors = next
    for (const listener of [...errorListeners]) listener()
  }

  function reportError(error: ErrorInput): void {
    // 同样内容只保留一条；console.error 带上插件 id 便于定位。
    const id = `${error.pluginId}:${error.kind}:${error.detail}`
    if (!errors.some((item) => item.id === id)) setErrors([...errors, { ...error, id }])
    console.error(`[plugin:${error.pluginId}] ${error.kind}: ${error.detail}`)
  }

  function dropErrors(keep: (error: PluginError) => boolean): void {
    const next = errors.filter(keep)
    if (next.length !== errors.length) setErrors(next)
  }

  function createContext(pluginId: string, bucket: Array<() => void>): ClientPluginContext {
    const owner: ContributionOwner = { kind: "plugin", id: pluginId }
    return {
      slots: {
        register(name, entry) {
          if (!isSlotName(name)) return () => undefined
          const key = `${name}:${entry.id}`
          const existing = slotOwners.get(key)
          if (existing) {
            reportError({ pluginId, kind: "slotConflict", detail: key, owner: existing.pluginId })
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
          // 只释放本次注册；旧插件的清理不能误删新注册的归属。
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
      panels: {
        register(panel) {
          checkContribution("panels", panel)
          return deps.extensions.register("panel", {
            id: panel.id,
            owner,
            order: panel.order ?? 0,
            title: { text: panel.title },
            render: () => <PluginContentHost id={panel.id} render={panel.render} kind="panel" />,
          })
        },
      },
      surfaces: {
        register(surface) {
          checkContribution("surfaces", surface)
          return deps.extensions.register("surface", {
            id: surface.id,
            owner,
            order: surface.order ?? 0,
            title: { text: surface.title },
            ...(surface.description ? { description: { text: surface.description } } : {}),
            icon: Puzzle,
            render: () => (
              <div className="surface-pane surface-scroll">
                <PluginContentHost id={surface.id} render={surface.render} kind="surface" />
              </div>
            ),
          })
        },
      },
      settingsPages: {
        register(page) {
          checkContribution("settingsPages", page)
          return deps.extensions.register("settingsPage", {
            id: page.id,
            owner,
            order: page.order ?? 0,
            title: { text: page.title },
            icon: Puzzle,
            // 宿主画和内置设置页一样的页面与标题，插件只画标题下面的内容。
            render: () => (
              <SettingPage title={page.title}>
                <PluginContentHost id={page.id} render={page.render} kind="settings" />
              </SettingPage>
            ),
          })
        },
      },
      ui,
      theme,
      locale,
    }
  }

  /** 应用一个插件；apply 抛错时记一条错误，已经登记的内容照常保留到卸载。 */
  function apply(entry: BootEntry, module: ClientModule): LoadedPlugin {
    const bucket: Array<() => void> = []
    let cleanup: () => void = () => undefined
    try {
      cleanup = applyClientPlugin(module, createContext(entry.id, bucket))
    } catch (error) {
      reportError({ pluginId: entry.id, kind: "apply", detail: messageOf(error) })
    }
    return {
      revision: entry.revision,
      module,
      unload() {
        try {
          cleanup()
        } catch (error) {
          console.error(`[plugin:${entry.id}] ${messageOf(error)}`)
        }
        for (const release of bucket.reverse()) release()
        // 插件没有自己注销的 Contribution 在这里一并移除；打开着的 Surface 随之关闭。
        deps.extensions.removeOwner({ kind: "plugin", id: entry.id })
        // import 错误属于 boot graph 里的条目，不属于这次应用：重试或条目消失时才清掉。
        dropErrors((error) => error.pluginId !== entry.id || error.kind === "import")
      },
    }
  }

  function unload(pluginId: string): void {
    const plugin = loaded.get(pluginId)
    if (!plugin) return
    loaded.delete(pluginId)
    plugin.unload()
  }

  /** 插件有没有因为和 removed 里的某个插件重名而被拒绝过（扩展点或 slot）。 */
  function lostTo(pluginId: string, removed: ReadonlySet<string>): boolean {
    const extensionConflict = deps.extensions
      .conflicts()
      .some(
        (conflict) =>
          conflict.rejected.kind === "plugin" &&
          conflict.rejected.id === pluginId &&
          conflict.existing.kind === "plugin" &&
          removed.has(conflict.existing.id),
      )
    return (
      extensionConflict ||
      errors.some(
        (error) =>
          error.pluginId === pluginId && error.kind === "slotConflict" && removed.has(error.owner),
      )
    )
  }

  async function reload(): Promise<void> {
    const ticket = ++requested
    let boot: BootGraph
    try {
      const response = await fetch("pigcode-plugin://boot.json")
      if (!response.ok) return
      boot = (await response.json()) as BootGraph
    } catch {
      // 读不到 boot graph 时什么也不改，正在进行的 reload 照常完成。
      return
    }
    // 更晚发起的 reload 已经拿到了 boot graph：这份是旧的。
    if (ticket < generation) return
    generation = ticket

    // 1. 新出现和换了版本的 bundle 先全部 import；这期间界面上的插件保持原样。
    const imported = new Map<string, ClientModule>()
    for (const entry of boot.entries) {
      if (loaded.get(entry.id)?.revision === entry.revision) continue
      dropErrors((error) => !(error.pluginId === entry.id && error.kind === "import"))
      try {
        imported.set(entry.id, await importModule(entry.url))
      } catch (error) {
        if (generation !== ticket) return
        // 没有加载成功的插件不算已加载，下次 reload 重试；换版本失败时旧版本继续用。
        reportError({ pluginId: entry.id, kind: "import", detail: messageOf(error) })
        continue
      }
      if (generation !== ticket) return
    }

    // 2. 同步完成卸载与应用，中间没有 await，界面只看到最终结果。先全部卸载，再按 boot 顺序应用。
    const wanted = new Map(boot.entries.map((entry) => [entry.id, entry]))
    const removed = new Set<string>()
    for (const [id, plugin] of [...loaded]) {
      const entry = wanted.get(id)
      if (entry && (entry.revision === plugin.revision || !imported.has(id))) continue
      unload(id)
      removed.add(id)
    }
    dropErrors((error) => wanted.has(error.pluginId))
    // 被刚卸载的插件挤掉过 id 的插件重新应用；它们卸载后又可能空出别的 id，直到没有新的。
    const reapply = new Map<string, LoadedPlugin>()
    for (let found = true; found;) {
      found = false
      for (const [id, plugin] of [...loaded]) {
        if (!lostTo(id, removed)) continue
        reapply.set(id, plugin)
        unload(id)
        removed.add(id)
        found = true
      }
    }
    for (const entry of boot.entries) {
      if (loaded.has(entry.id)) continue
      const module = imported.get(entry.id)
      const previous = reapply.get(entry.id)
      if (module) loaded.set(entry.id, apply(entry, module))
      // 重新应用的插件用它原来的模块与版本；它的新版本没有加载成功时，下次 reload 照常重试。
      else if (previous)
        loaded.set(entry.id, apply({ ...entry, revision: previous.revision }, previous.module))
    }
  }

  return {
    errors: {
      get: () => errors,
      subscribe(listener) {
        errorListeners.add(listener)
        return () => {
          errorListeners.delete(listener)
        }
      },
    },
    reload,
    dispose() {
      generation = ++requested
      for (const id of [...loaded.keys()].reverse()) unload(id)
      setErrors([])
    },
  }
}
