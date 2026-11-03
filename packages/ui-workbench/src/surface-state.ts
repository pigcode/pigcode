/**
 * Workbench 的标签状态：打开、关闭、替换与更新标签的纯函数。可以打开哪些 Surface 由扩展点注册表决定；
 * 内置 Surface、插件的 Surface 与单个文件都放在同一组标签里。
 */

/** 文件标签的种类：从文件树或聊天里打开的单个文件，不是登记在扩展点上的 Surface。 */
export const FILE_SURFACE_KIND = "file"

/** 右侧面板里的一个标签。 */
export interface PanelSurface {
  id: string
  /** 标签对应的 Surface 的 id；文件标签是 FILE_SURFACE_KIND。 */
  kind: string
  title: string
  /** 浏览器最近一次导航的地址；面板随会话重新挂载时用它恢复页面。 */
  url?: string
  /** 文件标签显示的文件（工作目录内的相对路径）。 */
  path?: string
  /** 打开文件时定位到的行（从 1 开始）。 */
  line?: number
  /** 有未保存的修改；标签上显示圆点。 */
  dirty?: boolean
}

/** 一组标签与当前激活的标签；没有标签时 activeId 为 null，面板显示启动器。 */
export interface PanelSurfaceState {
  surfaces: PanelSurface[]
  activeId: string | null
}

/** 空面板。 */
export const EMPTY_SURFACE_STATE: PanelSurfaceState = { surfaces: [], activeId: null }

/**
 * 打开一个 Surface：单实例的 Surface 已经打开时只切换过去；多实例的追加新标签。
 * title 收到同种标签的序号（从 1 开始），用于生成「终端 2」这样的标题。
 */
export function addSurface(
  state: PanelSurfaceState,
  kind: string,
  id: string,
  title: (index: number) => string,
  options: { multiInstance?: boolean | undefined } = {},
): PanelSurfaceState {
  if (!options.multiInstance) {
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

/**
 * 关闭 Surface 已经注销的标签（插件停用或卸载时）：每关一个都按 closeSurface 的规则改选当前标签。
 * 文件标签不是 Surface，从不在这里关闭（未保存的修改要先经过确认）。没有要关的标签时原样返回。
 */
export function closeRemovedSurfaces(
  state: PanelSurfaceState,
  removed: ReadonlySet<string>,
): PanelSurfaceState {
  return state.surfaces
    .filter((surface) => surface.kind !== FILE_SURFACE_KIND && removed.has(surface.kind))
    .reduce((next, surface) => closeSurface(next, surface.id), state)
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
