/**
 * 文件资源管理器（参照 t3code）：目录按需加载，单子目录链合并成一行，搜索框按路径模糊搜索并显示
 * 带祖先目录的结果树；被忽略的条目淡化，git 改动带颜色与字母；只渲染可见的行；键盘可完整操作；
 * 右键弹出菜单，拖到输入框插入 @路径。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronsDownUp, RefreshCw, Search, X } from "lucide-react"
import { ExplorerRow, rowId } from "./file-explorer-row"
import {
  ancestorsOf,
  searchTree,
  visibleRows,
  type DirectoryState,
  type ExplorerEntry,
  type GitDecoration,
  type VisibleRow,
} from "./file-tree-model"

/** 目录列表；与 Host 的 workspace.list 返回值一致。 */
export interface ExplorerListing {
  entries: ExplorerEntry[]
  truncated: boolean
}

/** 路径搜索结果；与 Host 的 workspace.searchPaths 返回值一致。 */
export interface ExplorerSearchResult {
  entries: Array<{ path: string; kind: "file" | "directory" }>
  truncated: boolean
}

/** 资源管理器文案；容器按 locale 注入。 */
export interface FileExplorerLabels {
  tree: string
  search: string
  clearSearch: string
  refresh: string
  collapseAll: string
  empty: string
  loading: string
  noMatches: string
  searchTruncated: string
  loadFailed: string
}

const DEFAULT_LABELS: FileExplorerLabels = {
  tree: "工作区文件",
  search: "搜索文件",
  clearSearch: "清除搜索",
  refresh: "刷新",
  collapseAll: "全部收起",
  empty: "这个目录是空的",
  loading: "正在读取…",
  noMatches: "没有匹配的文件",
  searchTruncated: "匹配太多，只显示前 200 项；输入更具体的关键词",
  loadFailed: "读取失败",
}

/** 资源管理器属性。 */
export interface FileExplorerProps {
  /** 根目录的名字（项目名），显示在顶部。 */
  rootName: string
  loadDirectory: (path: string) => Promise<ExplorerListing>
  searchPaths: (query: string) => Promise<ExplorerSearchResult>
  onOpenFile: (path: string) => void
  /** 当前打开的文件或要定位的目录：展开祖先并滚到它。 */
  activePath?: string | null | undefined
  /** activePath 是目录时也展开它本身（从面包屑跳过来）。 */
  activeKind?: "file" | "directory" | undefined
  /** 递增时重新读取已展开的目录，例如 agent 改了文件或刚保存过。 */
  revision?: number | undefined
  git?: { files: ReadonlyMap<string, GitDecoration>; directories: ReadonlySet<string> } | null
  onContextMenu?:
    | ((
        entry: { path: string; kind: "file" | "directory" },
        point: { x: number; y: number },
      ) => void)
    | undefined
  /** 同一个 key 的展开状态在组件重新挂载后保留（切换标签、收起侧栏）。 */
  stateKey?: string | undefined
  /** 窄的侧栏样式：没有根目录标题。 */
  compact?: boolean | undefined
  labels?: Partial<FileExplorerLabels> | undefined
}

/** 按 stateKey 保存的展开状态与已加载目录。 */
const memory = new Map<
  string,
  { directories: Map<string, DirectoryState>; expanded: Set<string> }
>()

const OVERSCAN = 8

/** 渲染资源管理器。 */
export function FileExplorer({
  rootName,
  loadDirectory,
  searchPaths,
  onOpenFile,
  activePath = null,
  activeKind = "file",
  revision = 0,
  git = null,
  onContextMenu,
  stateKey,
  compact = false,
  labels: overrides,
}: FileExplorerProps) {
  const labels = { ...DEFAULT_LABELS, ...overrides }
  const remembered = stateKey ? memory.get(stateKey) : undefined
  const [directories, setDirectories] = useState(
    () => remembered?.directories ?? new Map<string, DirectoryState>(),
  )
  const [expanded, setExpanded] = useState(() => remembered?.expanded ?? new Set<string>())
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<ExplorerSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [focused, setFocused] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const scroller = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ directories, expanded, loadDirectory })
  latest.current = { directories, expanded, loadDirectory }
  const idPrefix = useMemo(() => `fx-${Math.random().toString(36).slice(2, 8)}`, [])
  // 与 tokens.css 的 --row-h-compact 相同：虚拟滚动按这个高度定位每一行
  const rowHeight = 24

  useEffect(() => {
    if (stateKey) memory.set(stateKey, { directories, expanded })
  }, [stateKey, directories, expanded])

  /** 读取一个目录；目录只有一个子目录时顺着展开下去，与紧凑文件夹配合。 */
  async function load(path: string, autoExpand = false): Promise<DirectoryState | null> {
    setLoading((current) => new Set(current).add(path))
    try {
      const listing = await latest.current.loadDirectory(path)
      const state: DirectoryState = { entries: listing.entries, truncated: listing.truncated }
      setDirectories((current) => new Map(current).set(path, state))
      setFailed((current) => {
        if (!current.has(path)) return current
        const next = new Map(current)
        next.delete(path)
        return next
      })
      const only = state.entries.length === 1 ? state.entries[0] : undefined
      if (autoExpand && only?.kind === "directory") {
        setExpanded((current) => new Set(current).add(only.path))
        void load(only.path, true)
      }
      return state
    } catch (error) {
      setFailed((current) =>
        new Map(current).set(path, error instanceof Error ? error.message : String(error)),
      )
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
      return null
    } finally {
      setLoading((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
    }
  }

  // 首次挂载读根目录；revision 变化时重读根目录与所有展开的目录。
  useEffect(() => {
    const { expanded: open } = latest.current
    void load("")
    for (const path of open) void load(path)
  }, [revision, loadDirectory])

  // 定位当前文件（或从面包屑点到的目录）：逐级读取并展开祖先目录，再滚到它。
  useEffect(() => {
    if (!activePath) return
    let cancelled = false
    void (async () => {
      const targets = [
        ...ancestorsOf(activePath),
        ...(activeKind === "directory" ? [activePath] : []),
      ]
      for (const path of targets) {
        if (cancelled) return
        if (!latest.current.directories.has(path)) await load(path)
        setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)))
      }
      if (!cancelled) setFocused(activePath)
    })()
    return () => {
      cancelled = true
    }
  }, [activePath, activeKind])

  // 搜索：输入停顿 120ms 后查询；清空时回到目录树。
  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResults(null)
      setSearching(false)
      return undefined
    }
    setSearching(true)
    let cancelled = false
    const timer = setTimeout(() => {
      void searchPaths(text)
        .then((found) => {
          if (!cancelled) setResults(found)
        })
        .catch(() => {
          if (!cancelled) setResults({ entries: [], truncated: false })
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, searchPaths])

  const rows = useMemo<VisibleRow[]>(() => {
    if (results) {
      const tree = searchTree(results.entries)
      return visibleRows(tree.directories, tree.expanded)
    }
    return visibleRows(directories, expanded)
  }, [results, directories, expanded])

  // 量出可视高度；jsdom 等没有 ResizeObserver 的环境按一屏估算。
  useEffect(() => {
    const element = scroller.current
    if (!element || typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    setViewport(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  const height = viewport || 640
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN)
  const focusedIndex = rows.findIndex((row) => row.path === focused)

  /** 把某一行滚进可视区。 */
  function reveal(index: number): void {
    const element = scroller.current
    if (!element || index < 0) return
    const top = index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight
    }
  }

  useEffect(() => {
    if (focusedIndex >= 0) reveal(focusedIndex)
  }, [focusedIndex])

  function toggle(row: VisibleRow): void {
    if (results) {
      // 搜索结果里点目录：回到目录树并定位到它。
      setQuery("")
      setFocused(row.path)
      void (async () => {
        for (const path of [...ancestorsOf(row.path), row.path]) {
          if (!latest.current.directories.has(path)) await load(path)
          setExpanded((current) => new Set(current).add(path))
        }
      })()
      return
    }
    const open = expanded.has(row.path)
    setExpanded((current) => {
      const next = new Set(current)
      if (open) next.delete(row.path)
      else next.add(row.path)
      return next
    })
    if (!open && !directories.has(row.path)) void load(row.path, true)
  }

  function activate(row: VisibleRow): void {
    setFocused(row.path)
    if (row.kind === "file") onOpenFile(row.path)
    else toggle(row)
  }

  function collapseAll(): void {
    setExpanded(new Set())
    setQuery("")
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (rows.length === 0) return
    const index = focusedIndex === -1 ? 0 : focusedIndex
    const row = rows[index]
    if (!row) return
    const page = Math.max(1, Math.floor(height / rowHeight) - 1)
    const move = (target: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, target))]
      if (next) setFocused(next.path)
    }
    switch (event.key) {
      case "ArrowDown":
        move(focusedIndex === -1 ? 0 : index + 1)
        break
      case "ArrowUp":
        move(index - 1)
        break
      case "PageDown":
        move(index + page)
        break
      case "PageUp":
        move(index - page)
        break
      case "Home":
        move(0)
        break
      case "End":
        move(rows.length - 1)
        break
      case "ArrowRight":
        if (row.kind !== "directory") return
        if (!row.expanded) toggle(row)
        else move(index + 1)
        break
      case "ArrowLeft":
        if (row.kind === "directory" && row.expanded && !results) toggle(row)
        else {
          for (let at = index - 1; at >= 0; at -= 1) {
            if ((rows[at]?.depth ?? 0) < row.depth) {
              move(at)
              break
            }
          }
        }
        break
      case "Enter":
      case " ":
        activate(row)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const rootState = directories.get("")
  const rootError = failed.get("")
  const empty = results
    ? results.entries.length === 0 && !searching
      ? labels.noMatches
      : null
    : rootError
      ? `${labels.loadFailed}: ${rootError}`
      : rootState && rootState.entries.length === 0
        ? labels.empty
        : !rootState
          ? labels.loading
          : null

  return (
    <div className={compact ? "fx fx-compact" : "fx"}>
      <div className="fx-head">
        {compact ? null : (
          <span className="fx-root truncate" title={rootName}>
            {rootName}
          </span>
        )}
        <span className="fx-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label={labels.refresh}
            title={labels.refresh}
            onClick={() => {
              void load("")
              for (const path of expanded) void load(path)
            }}
          >
            <RefreshCw
              className={loading.size > 0 ? "ic ic-sm spin" : "ic ic-sm"}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={labels.collapseAll}
            title={labels.collapseAll}
            onClick={collapseAll}
          >
            <ChevronsDownUp className="ic ic-sm" aria-hidden="true" />
          </button>
        </span>
      </div>
      <label className="fx-search">
        <Search className="ic ic-sm" aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={labels.search}
          aria-label={labels.search}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("")
            if (event.key === "ArrowDown") {
              event.preventDefault()
              const first = rows[0]
              if (first) setFocused(first.path)
              scroller.current?.focus()
            }
          }}
        />
        {query ? (
          <button type="button" aria-label={labels.clearSearch} onClick={() => setQuery("")}>
            <X className="ic ic-sm" aria-hidden="true" />
          </button>
        ) : null}
      </label>
      {results?.truncated ? <p className="fx-note">{labels.searchTruncated}</p> : null}
      <div
        ref={scroller}
        className="fx-scroll"
        role="tree"
        aria-label={labels.tree}
        tabIndex={0}
        {...(focusedIndex >= 0
          ? { "aria-activedescendant": rowId(idPrefix, rows[focusedIndex]?.path ?? "") }
          : {})}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onTreeKeyDown}
        onFocus={() => {
          if (focused === null && rows[0]) setFocused(activePath ?? rows[0].path)
        }}
      >
        {empty ? <p className="fx-empty">{empty}</p> : null}
        <div className="fx-rows" style={{ height: rows.length * rowHeight }}>
          {rows.slice(first, last).map((row, offset) => (
            <ExplorerRow
              key={row.path}
              row={row}
              id={rowId(idPrefix, row.path)}
              top={(first + offset) * rowHeight}
              height={rowHeight}
              query={query}
              active={row.path === activePath}
              focused={row.path === focused}
              loading={loading.has(row.path)}
              error={failed.get(row.path)}
              decoration={row.kind === "file" ? git?.files.get(row.path) : undefined}
              changedInside={row.kind === "directory" && git?.directories.has(row.path) === true}
              onActivate={() => activate(row)}
              onContextMenu={
                onContextMenu
                  ? (point) => {
                      setFocused(row.path)
                      onContextMenu({ path: row.path, kind: row.kind }, point)
                    }
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}
