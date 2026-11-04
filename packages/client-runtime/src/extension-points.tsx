/**
 * 扩展点注册表：内置功能和插件登记界面的唯一入口（见聚合仓库 adr/0001）。只有五个扩展点：
 * Panel、Surface、设置页、Command、工具渲染器。每个 Contribution 有 id、归属（owner）和顺序，
 * 同一扩展点上 id 唯一：后登记的同名条目被拒绝并记一条冲突，不会覆盖先登记的。
 * 插件停用时按 owner 一次移除它的全部 Contribution。
 */
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react"
import type { MessageKey } from "@pigcode/ui-primitives"

/** Contribution 的归属：一项内置功能，或一个插件（id 是插件 id）。 */
export type ContributionOwner = { kind: "builtin"; id: string } | { kind: "plugin"; id: string }

/** 界面文字：内置功能给语言包里的 key，插件给自己按界面语言选好的文字。 */
export type ContributionText = { key: MessageKey } | { text: string }

/** 把 ContributionText 换成当前语言的文字。 */
export function contributionText(t: (key: MessageKey) => string, value: ContributionText): string {
  return "key" in value ? t(value.key) : value.text
}

/** 每个 Contribution 都有的字段。 */
export interface ContributionBase {
  /** 在同一扩展点上唯一。 */
  id: string
  owner: ContributionOwner
  /** 小的在前；相同时按 id 排。 */
  order: number
}

/** 图标组件，例如 lucide 的图标。 */
export type ContributionIcon = ComponentType<{ className?: string; "aria-hidden"?: "true" }>

/** Panel：左侧栏里的一个区块。宿主画可以收起的标题，render 画内容。 */
export interface PanelContribution extends ContributionBase {
  title: ContributionText
  render(): ReactNode
}

/** Workbench 里的一个标签。 */
export interface SurfaceTab {
  id: string
  /** 标签对应的 Surface 的 id。 */
  kind: string
  title: string
  url?: string
  path?: string
  line?: number
}

/** Surface 的 render 收到的参数。 */
export interface SurfaceRenderProps {
  tab: SurfaceTab
  /** 标签当前是否显示。 */
  active: boolean
}

/** Surface：Workbench 里的一种标签，列在启动器和「+」菜单里。 */
export interface SurfaceContribution extends ContributionBase {
  /** 启动器和菜单里的名称，也是新标签的默认标题。 */
  title: ContributionText
  /** 鼠标悬停在启动器条目上时显示的说明。 */
  description?: ContributionText
  icon: ContributionIcon
  /** 启动器与菜单里的单键快捷键（大写字母）。 */
  shortcut?: string
  /** 可以同时打开多个；否则再次打开时切到已有标签。 */
  multiInstance?: boolean
  /** 切到别的标签时保持挂载（终端、浏览器）；否则只在显示时渲染。 */
  keepMounted?: boolean
  /** 新标签的标题；index 是同种标签的序号，从 1 开始。缺省用名称。 */
  tabTitle?: (name: string, index: number) => string
  /** 暂时不能打开的原因；返回 null 表示可以打开。启动器和菜单里置灰，悬停显示原因。 */
  unavailable?: () => MessageKey | null
  render(props: SurfaceRenderProps): ReactNode
}

/**
 * 设置页：设置侧栏里的一项和它对应的内容。侧栏导航与搜索都从这里生成；内置的页列在「设置」组，
 * 插件的列在后面的「插件设置」组。
 */
export interface SettingsPageContribution extends ContributionBase {
  /** 侧栏里的名称，也是搜索比对的文字。 */
  title: ContributionText
  icon: ContributionIcon
  /** 页面内容，画在设置的内容区里。 */
  render(): ReactNode
}

/**
 * Command：命令面板和输入框里的 `/` 共用的一个具名操作。命令面板按 title 与 keywords 过滤并显示
 * shortcut；提供了 slash 的命令同时出现在 `/` 建议里，触发名就是 slash。
 */
export interface CommandContribution extends ContributionBase {
  title: ContributionText
  /** 额外的搜索词。 */
  keywords?: readonly string[]
  /** 快捷键提示，例如 `Mod+n`；只用于显示，快捷键本身由宿主注册。 */
  shortcut?: string
  /** 命令面板里的图标名；缺省用通用的闪电图标。 */
  icon?: string
  /** 现在能不能执行；缺省为能。不能执行时命令面板与 `/` 都不列出。 */
  available?: () => boolean
  /** `/` 触发名，例如 `new` 对应 `/new`；缺省时只出现在命令面板。 */
  slash?: string
  run(): void | Promise<void>
}

/** 工具渲染器看到的一次工具调用；和时间线（ui-chat 的 ToolCall）的结构相同。 */
export interface ToolRendererCall {
  id: string
  name: string
  status: "running" | "completed" | "failed" | "stopped"
  /** 输入与输出的文字形式。 */
  input: string | undefined
  output: string | undefined
  /** 事件里原样的输入与输出。 */
  inputValue?: unknown
  outputValue?: unknown
  startedAt?: string | undefined
  endedAt?: string | undefined
  /** 命令的退出码；Agent 不报告时缺省。 */
  exitCode?: number | undefined
}

/** 工具渲染器的 render 收到的参数。 */
export interface ToolRendererProps {
  tool: ToolRendererCall
  /** 运行中的命令已经流出的输出；只传给命令的渲染器。 */
  live?: string | undefined
  /** 分组里的子项不显示图标。 */
  showIcon: boolean
}

/**
 * 内置工具渲染器的 order。优先级就是 order：小的在前，第一个匹配的生效。内置的 MCP 渲染器匹配所有
 * `mcp__` 工具，内置的排在 1000，缺省 order 为 0 的插件渲染器才能排在它前面。
 * 按族匹配的插件渲染器应该自己给 1 到 999（或大于 1000），不要留在 0：同为 0 时只能按 id 决胜负。
 * 正好等于 1000 也会按 id 和内置渲染器比，没有意义。
 */
export const BUILTIN_TOOL_RENDERER_ORDER = 1000

/**
 * 工具渲染器：决定一类工具调用在对话时间线里怎么显示。时间线取第一个匹配的；都不匹配时用
 * ui-chat 的通用渲染器。
 */
export interface ToolRendererContribution extends ContributionBase {
  /** 这个渲染器负责的工具调用。渲染时调用，要快，不能抛错。 */
  matches(toolName: string): boolean
  render(props: ToolRendererProps): ReactNode
}

/** 五个扩展点与各自的 Contribution 形状。 */
export interface ExtensionPointMap {
  panel: PanelContribution
  surface: SurfaceContribution
  settingsPage: SettingsPageContribution
  command: CommandContribution
  toolRenderer: ToolRendererContribution
}

/** 扩展点名称。 */
export type ExtensionPoint = keyof ExtensionPointMap

/** 全部扩展点。 */
export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  "panel",
  "surface",
  "settingsPage",
  "command",
  "toolRenderer",
]

/** 一次被拒绝的登记：point 上的 id 已经属于 existing，rejected 的同名登记没有生效。 */
export interface ContributionConflict {
  point: ExtensionPoint
  id: string
  existing: ContributionOwner
  rejected: ContributionOwner
}

/** 扩展点注册表。get 与 conflicts 返回不可变快照，内容变化时才换新数组。 */
export interface ExtensionRegistry {
  /** 登记一项 Contribution，返回注销函数；id 冲突时不登记，记一条冲突，返回什么也不做的函数。 */
  register<P extends ExtensionPoint>(point: P, contribution: ExtensionPointMap[P]): () => void
  /** 某个扩展点上的 Contribution，按 order、id 排序。 */
  get<P extends ExtensionPoint>(point: P): readonly ExtensionPointMap[P][]
  subscribe(point: ExtensionPoint, listener: () => void): () => void
  /**
   * 预留一个 id：它不出现在 get 里，但别人用这个 id 登记时按冲突拒绝，冲突的先登记方是 owner。
   * 用于宿主自己占用、但不是 Contribution 的名字，例如文件标签的种类 "file"。返回取消预留的函数。
   */
  reserve(point: ExtensionPoint, id: string, owner: ContributionOwner): () => void
  /**
   * 移除 owner 的全部 Contribution 和它被拒绝的登记记录（插件停用时）。owner 作为先登记方的冲突记录保留：
   * 被拒绝的一方并没有因此得到这个 id，要重新应用它才行（插件控制器在 reload 里这样做）。
   */
  removeOwner(owner: ContributionOwner): void
  conflicts(): readonly ContributionConflict[]
  subscribeConflicts(listener: () => void): () => void
}

function sameOwner(a: ContributionOwner, b: ContributionOwner): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** 按 order、id 排序。 */
function byOrder(a: ContributionBase, b: ContributionBase): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 冲突写进控制台用的 owner 名称。 */
function ownerName(owner: ContributionOwner): string {
  return `${owner.kind}:${owner.id}`
}

/** 空列表；没有内容时总是同一个数组，useSyncExternalStore 不会因此重渲染。 */
const NONE: readonly never[] = []

/** 创建一个空的扩展点注册表。 */
export function createExtensionRegistry(): ExtensionRegistry {
  const entries = new Map<ExtensionPoint, Map<string, ContributionBase>>()
  const snapshots = new Map<ExtensionPoint, readonly ContributionBase[]>()
  const listeners = new Map<ExtensionPoint, Set<() => void>>()
  const conflictListeners = new Set<() => void>()
  const reserved = new Map<ExtensionPoint, Map<string, ContributionOwner>>()
  let conflicts: readonly ContributionConflict[] = []

  function pointEntries(point: ExtensionPoint): Map<string, ContributionBase> {
    let map = entries.get(point)
    if (!map) {
      map = new Map()
      entries.set(point, map)
    }
    return map
  }

  function changed(point: ExtensionPoint): void {
    snapshots.set(point, [...pointEntries(point).values()].sort(byOrder))
    for (const listener of [...(listeners.get(point) ?? [])]) listener()
  }

  function setConflicts(next: readonly ContributionConflict[]): void {
    conflicts = next
    for (const listener of [...conflictListeners]) listener()
  }

  return {
    register(point, contribution) {
      const map = pointEntries(point)
      const holder = reserved.get(point)?.get(contribution.id) ?? map.get(contribution.id)?.owner
      if (holder) {
        setConflicts([
          ...conflicts,
          { point, id: contribution.id, existing: holder, rejected: contribution.owner },
        ])
        console.error(
          `[extension-points] ${point} "${contribution.id}" from ${ownerName(contribution.owner)} ` +
            `was rejected: already registered by ${ownerName(holder)}`,
        )
        return () => undefined
      }
      map.set(contribution.id, contribution)
      changed(point)
      return () => {
        // 只注销本次登记的条目：同名的位置可能已经属于后来登记的另一项。
        if (map.get(contribution.id) !== contribution) return
        map.delete(contribution.id)
        changed(point)
      }
    },
    get<P extends ExtensionPoint>(point: P) {
      return (snapshots.get(point) ?? NONE) as readonly ExtensionPointMap[P][]
    },
    subscribe(point, listener) {
      let set = listeners.get(point)
      if (!set) {
        set = new Set()
        listeners.set(point, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    reserve(point, id, owner) {
      let ids = reserved.get(point)
      if (!ids) {
        ids = new Map()
        reserved.set(point, ids)
      }
      ids.set(id, owner)
      return () => {
        if (ids.get(id) === owner) ids.delete(id)
      }
    },
    removeOwner(owner) {
      for (const [point, map] of entries) {
        let removed = false
        for (const [id, contribution] of map) {
          if (!sameOwner(contribution.owner, owner)) continue
          map.delete(id)
          removed = true
        }
        if (removed) changed(point)
      }
      const kept = conflicts.filter((conflict) => !sameOwner(conflict.rejected, owner))
      if (kept.length !== conflicts.length) setConflicts(kept)
    },
    conflicts: () => conflicts,
    subscribeConflicts(listener) {
      conflictListeners.add(listener)
      return () => {
        conflictListeners.delete(listener)
      }
    },
  }
}

const ExtensionRegistryContext = createContext<ExtensionRegistry | null>(null)

/** 让下面的组件从 registry 读取 Contribution。 */
export function ExtensionRegistryScope({
  registry,
  children,
}: {
  registry: ExtensionRegistry
  children?: ReactNode
}) {
  return (
    <ExtensionRegistryContext.Provider value={registry}>
      {children}
    </ExtensionRegistryContext.Provider>
  )
}

/** 当前作用域里的注册表；没有 ExtensionRegistryScope 时是 null。改注册表本身（登记、注销）时用它。 */
export function useExtensionRegistry(): ExtensionRegistry | null {
  return useContext(ExtensionRegistryContext)
}

/**
 * 读取一个扩展点上的 Contribution（按 order、id 排序），变化时重渲染。
 * 默认读外层 ExtensionRegistryScope 的 registry；外面没有 ExtensionRegistryScope 时是空列表。
 */
export function useContributions<P extends ExtensionPoint>(
  point: P,
  registry?: ExtensionRegistry,
): readonly ExtensionPointMap[P][] {
  const provided = useContext(ExtensionRegistryContext)
  const source = registry ?? provided
  const subscribe = useCallback(
    (listener: () => void) => source?.subscribe(point, listener) ?? (() => undefined),
    [source, point],
  )
  const read = () => source?.get(point) ?? NONE
  return useSyncExternalStore(subscribe, read, read)
}

/** 读取被拒绝的登记，变化时重渲染。 */
export function useContributionConflicts(
  registry?: ExtensionRegistry,
): readonly ContributionConflict[] {
  const provided = useContext(ExtensionRegistryContext)
  const source = registry ?? provided
  const subscribe = useCallback(
    (listener: () => void) => source?.subscribeConflicts(listener) ?? (() => undefined),
    [source],
  )
  const read = () => source?.conflicts() ?? NONE
  return useSyncExternalStore(subscribe, read, read)
}
