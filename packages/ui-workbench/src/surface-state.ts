/**
 * 右侧面板的标签状态：可以打开的 surface 种类、快捷键，以及打开、关闭、替换与更新标签的纯函数。
 * 内置 surface、单个文件与插件注册的标签都放在同一组标签里。
 */

/** 可以打开的 surface 种类；顺序即启动器与添加菜单里的顺序。 */
export const SURFACE_KINDS = ["browser", "terminal", "files", "diff", "pr", "checkpoint"] as const

/** surface 种类标识。 */
export type SurfaceKind = (typeof SURFACE_KINDS)[number]

/** 启动器与添加菜单里的单键快捷键。 */
export const SURFACE_SHORTCUTS: Record<SurfaceKind, string> = {
  browser: "B",
  terminal: "T",
  files: "F",
  diff: "D",
  pr: "P",
  checkpoint: "C",
}

/** 可以同时打开多个实例的种类；其余种类再次打开时切到已有标签。 */
export const MULTI_INSTANCE_KINDS: ReadonlySet<SurfaceKind> = new Set(["browser", "terminal"])

/** 标签的种类：启动器里的 surface、从文件树或聊天里打开的单个文件，以及插件的标签。 */
export type PanelSurfaceKind = SurfaceKind | "file" | "plugin"

/** 插件注册的一种标签。 */
export interface PluginSurfaceOption {
  id: string
  title: string
  description?: string | undefined
}

/** 右侧面板里的一个标签。 */
export interface PanelSurface {
  id: string
  kind: PanelSurfaceKind
  title: string
  /** 浏览器最近一次导航的地址；面板随会话重新挂载时用它恢复页面。 */
  url?: string
  /** 文件标签显示的文件（工作目录内的相对路径）。 */
  path?: string
  /** 打开文件时定位到的行（从 1 开始）。 */
  line?: number
  /** 有未保存的修改；标签上显示圆点。 */
  dirty?: boolean
  /** 插件标签对应的插件 surface id。 */
  plugin?: string
}

/** 一组标签与当前激活的标签；没有标签时 activeId 为 null，面板显示启动器。 */
export interface PanelSurfaceState {
  surfaces: PanelSurface[]
  activeId: string | null
}

/** 空面板。 */
export const EMPTY_SURFACE_STATE: PanelSurfaceState = { surfaces: [], activeId: null }

/**
 * 打开一个 surface：单实例种类已存在时只切换过去；多实例种类追加新标签。
 * title 收到同种类的序号（从 1 开始），用于生成「终端 2」这样的标题。
 */
export function addSurface(
  state: PanelSurfaceState,
  kind: SurfaceKind,
  id: string,
  title: (index: number) => string,
): PanelSurfaceState {
  if (!MULTI_INSTANCE_KINDS.has(kind)) {
    const existing = state.surfaces.find((surface) => surface.kind === kind)
    if (existing) return { ...state, activeId: existing.id }
  }
  const used = new Set(
    state.surfaces.filter((surface) => surface.kind === kind).map((surface) => surface.title),
  )
  let index = 1
  while (used.has(title(index))) index += 1
  return {
    surfaces: [...state.surfaces, { id, kind, title: title(index) }],
    activeId: id,
  }
}

/** 打开一个插件标签：每种插件标签只开一个，已经打开时切过去。 */
export function addPluginSurface(
  state: PanelSurfaceState,
  plugin: PluginSurfaceOption,
  id: string,
): PanelSurfaceState {
  const existing = state.surfaces.find(
    (surface) => surface.kind === "plugin" && surface.plugin === plugin.id,
  )
  if (existing) return { ...state, activeId: existing.id }
  return {
    surfaces: [...state.surfaces, { id, kind: "plugin", title: plugin.title, plugin: plugin.id }],
    activeId: id,
  }
}

/** 关闭一个 surface；关闭的是当前标签时激活右侧邻居，没有则激活左侧邻居。 */
export function closeSurface(state: PanelSurfaceState, id: string): PanelSurfaceState {
  const index = state.surfaces.findIndex((surface) => surface.id === id)
  if (index === -1) return state
  const surfaces = state.surfaces.filter((surface) => surface.id !== id)
  if (state.activeId !== id) return { surfaces, activeId: state.activeId }
  const next = surfaces[index] ?? surfaces[index - 1] ?? null
  return { surfaces, activeId: next?.id ?? null }
}

/**
 * 打开一个文件标签：同一文件已经打开时切过去（并更新要定位的行）；
 * replace 给出时用新标签替换那个标签（从文件树标签打开文件时，文件树收进文件标签的侧栏）。
 */
export function openFileSurface(
  state: PanelSurfaceState,
  path: string,
  id: string,
  options: { line?: number | undefined; replace?: string | undefined } = {},
): PanelSurfaceState {
  const title = path.split("/").at(-1) ?? path
  const existing = state.surfaces.find(
    (surface) => surface.kind === "file" && surface.path === path,
  )
  if (existing) {
    const surfaces = state.surfaces
      .filter((surface) => surface.id !== options.replace || surface.id === existing.id)
      .map((surface) =>
        surface.id === existing.id && options.line ? { ...surface, line: options.line } : surface,
      )
    return { surfaces, activeId: existing.id }
  }
  const surface: PanelSurface = {
    id,
    kind: "file",
    title,
    path,
    ...(options.line ? { line: options.line } : {}),
  }
  const index = options.replace
    ? state.surfaces.findIndex((item) => item.id === options.replace)
    : -1
  const surfaces =
    index === -1
      ? [...state.surfaces, surface]
      : [...state.surfaces.slice(0, index), surface, ...state.surfaces.slice(index + 1)]
  return { surfaces, activeId: id }
}

/** 修改某个标签的标题、地址、文件或未保存状态，例如浏览器加载页面后显示主机名。 */
export function updateSurface(
  state: PanelSurfaceState,
  id: string,
  patch: Partial<Pick<PanelSurface, "title" | "url" | "path" | "dirty">>,
): PanelSurfaceState {
  return {
    ...state,
    surfaces: state.surfaces.map((surface) =>
      surface.id === id ? { ...surface, ...patch } : surface,
    ),
  }
}
