/**
 * 文件树的纯数据逻辑：已加载的目录 + 展开集合 → 可见行（单子目录链合并成一行），
 * 搜索结果 → 带祖先目录的临时树，以及路径的祖先与模糊匹配位置。组件只负责渲染与交互。
 */

/** 目录里的一项；字段与 Host 的 workspace.list 一致。 */
export interface ExplorerEntry {
  path: string
  name: string
  kind: "file" | "directory"
  ignored?: boolean | undefined
  symlink?: boolean | undefined
  size?: number | undefined
}

/** 一个已加载的目录。 */
export interface DirectoryState {
  entries: readonly ExplorerEntry[]
  truncated: boolean
}

/** 渲染用的一行。 */
export interface VisibleRow {
  /** 行对应的路径；合并的目录链取最深的那个目录。 */
  path: string
  /** 显示的名字；合并的目录链是 `src/main/java`。 */
  label: string
  kind: "file" | "directory"
  depth: number
  expanded: boolean
  ignored: boolean
  /** 父目录路径（根为空字符串），方向键 ← 用它跳回父级。 */
  parent: string
  entry: ExplorerEntry
}

/** 路径的全部祖先目录，从浅到深；根目录（空字符串）不算。 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"))
}

/** 父目录路径；顶层条目的父目录是空字符串。 */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

/**
 * 按展开状态展开出可见行。目录只有一个子目录、没有别的文件时与子目录合并成一行
 * （只合并已经加载过的层级），和 VS Code 的紧凑文件夹一样。
 */
export function visibleRows(
  directories: ReadonlyMap<string, DirectoryState>,
  expanded: ReadonlySet<string>,
  include?: (entry: ExplorerEntry) => boolean,
): VisibleRow[] {
  const rows: VisibleRow[] = []
  const walk = (directory: string, depth: number): void => {
    for (const entry of directories.get(directory)?.entries ?? []) {
      if (include && !include(entry)) continue
      if (entry.kind === "file") {
        rows.push({
          path: entry.path,
          label: entry.name,
          kind: "file",
          depth,
          expanded: false,
          ignored: entry.ignored === true,
          parent: directory,
          entry,
        })
        continue
      }
      let deepest = entry
      const names = [entry.name]
      for (;;) {
        const children = directories.get(deepest.path)?.entries
        const only = children?.length === 1 ? children[0] : undefined
        if (!only || only.kind !== "directory") break
        deepest = only
        names.push(only.name)
      }
      const open = expanded.has(deepest.path)
      rows.push({
        path: deepest.path,
        label: names.join("/"),
        kind: "directory",
        depth,
        expanded: open,
        ignored: entry.ignored === true || deepest.ignored === true,
        parent: directory,
        entry: deepest,
      })
      if (open) walk(deepest.path, depth + 1)
    }
  }
  walk("", 0)
  return rows
}

/** 加入 Git 已删除但磁盘上已经不再有目录项的文件，再按变更过滤目录树。 */
export function changedRows(
  directories: ReadonlyMap<string, DirectoryState>,
  expanded: ReadonlySet<string>,
  files: ReadonlyMap<string, GitDecoration>,
  include: (entry: ExplorerEntry) => boolean,
): VisibleRow[] {
  const withDeleted = new Map(directories)
  for (const [path, decoration] of files) {
    if (decoration !== "deleted") continue
    const parent = parentOf(path)
    const listing = withDeleted.get(parent)
    if (!listing || listing.entries.some((entry) => entry.path === path)) continue
    const entry: ExplorerEntry = { path, name: path.split("/").at(-1) ?? path, kind: "file" }
    withDeleted.set(parent, { ...listing, entries: [...listing.entries, entry] })
  }
  return visibleRows(withDeleted, expanded, include)
}

/** 搜索结果构成的临时树：命中的条目加上它们的祖先目录，全部展开。 */
export function searchTree(results: ReadonlyArray<{ path: string; kind: "file" | "directory" }>): {
  directories: Map<string, DirectoryState>
  expanded: Set<string>
} {
  const children = new Map<string, Map<string, ExplorerEntry>>()
  const add = (entry: ExplorerEntry): void => {
    const parent = parentOf(entry.path)
    const siblings = children.get(parent) ?? new Map<string, ExplorerEntry>()
    if (!siblings.has(entry.path)) siblings.set(entry.path, entry)
    children.set(parent, siblings)
  }
  for (const result of results) {
    for (const ancestor of ancestorsOf(result.path)) {
      add({ path: ancestor, name: ancestor.split("/").at(-1) ?? ancestor, kind: "directory" })
    }
    add({
      path: result.path,
      name: result.path.split("/").at(-1) ?? result.path,
      kind: result.kind,
    })
  }
  const directories = new Map<string, DirectoryState>()
  for (const [parent, entries] of children) {
    const sorted = [...entries.values()].sort((left, right) =>
      left.kind !== right.kind
        ? left.kind === "directory"
          ? -1
          : 1
        : left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    directories.set(parent, { entries: sorted, truncated: false })
  }
  return { directories, expanded: new Set([...children.keys()].filter(Boolean)) }
}

/**
 * 名字里与查询词按顺序匹配的字符位置，用来加粗；优先匹配连续的子串，
 * 否则逐字匹配。多个词时取最后一个词（通常是文件名部分）。不匹配时为空。
 */
export function fuzzyIndices(label: string, query: string): number[] {
  const word = query.trim().toLowerCase().split(/\s+/).at(-1) ?? ""
  if (!word) return []
  const lower = label.toLowerCase()
  const start = lower.indexOf(word)
  if (start !== -1) return Array.from({ length: word.length }, (_unused, index) => start + index)
  const indices: number[] = []
  let position = 0
  for (const char of word) {
    const index = lower.indexOf(char, position)
    if (index === -1) return []
    indices.push(index)
    position = index + 1
  }
  return indices
}

/** git 状态的种类；目录用于显示「里面有改动」的圆点。 */
export type GitDecoration = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict"

/** 把 porcelain 两位状态码归成一种装饰。 */
export function decorationOf(status: string): GitDecoration {
  if (status === "??") return "untracked"
  if (status.includes("U") || status === "AA" || status === "DD") return "conflict"
  if (status.includes("R") || status.includes("C")) return "renamed"
  if (status.includes("A")) return "added"
  if (status.includes("D")) return "deleted"
  return "modified"
}

/** 文件的装饰与「含有改动」的目录集合。 */
export function gitDecorations(changes: ReadonlyArray<{ path: string; status: string }>): {
  files: Map<string, GitDecoration>
  directories: Set<string>
} {
  const files = new Map<string, GitDecoration>()
  const directories = new Set<string>()
  for (const change of changes) {
    const path = change.path.replace(/\/$/, "")
    files.set(path, decorationOf(change.status))
    for (const ancestor of ancestorsOf(path)) directories.add(ancestor)
  }
  return { files, directories }
}
