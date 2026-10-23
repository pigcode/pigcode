/** 验证文件树的数据逻辑：可见行、紧凑文件夹、搜索树、模糊匹配位置、git 装饰与文件标签。 */
import { describe, expect, it } from "vitest"
import {
  ancestorsOf,
  decorationOf,
  fuzzyIndices,
  gitDecorations,
  parentOf,
  searchTree,
  visibleRows,
  type DirectoryState,
  type ExplorerEntry,
} from "./file-tree-model"
import { openFileSurface, type PanelSurfaceState } from "./right-panel"

const dir = (path: string, ignored = false): ExplorerEntry => ({
  path,
  name: path.split("/").at(-1) ?? path,
  kind: "directory",
  ...(ignored ? { ignored } : {}),
})
const file = (path: string): ExplorerEntry => ({
  path,
  name: path.split("/").at(-1) ?? path,
  kind: "file",
})
const listing = (...entries: ExplorerEntry[]): DirectoryState => ({ entries, truncated: false })

describe("visible rows", () => {
  it("walks expanded directories depth first", () => {
    const directories = new Map([
      ["", listing(dir("node_modules", true), dir("src"), file("README.md"))],
      ["src", listing(dir("src/lib"), file("src/index.ts"))],
      ["src/lib", listing(file("src/lib/a.ts"))],
    ])
    const rows = visibleRows(directories, new Set(["src"]))
    expect(rows.map((row) => [row.label, row.depth, row.expanded, row.ignored])).toEqual([
      ["node_modules", 0, false, true],
      ["src", 0, true, false],
      ["lib", 1, false, false],
      ["index.ts", 1, false, false],
      ["README.md", 0, false, false],
    ])
    expect(rows[2]?.parent).toBe("src")
  })

  it("merges chains of single loaded subdirectories into one row", () => {
    const directories = new Map([
      ["", listing(dir("app"))],
      ["app", listing(dir("app/src"))],
      ["app/src", listing(dir("app/src/main"))],
      ["app/src/main", listing(file("app/src/main/Main.java"), file("app/src/main/App.java"))],
    ])
    const collapsed = visibleRows(directories, new Set())
    expect(collapsed.map((row) => [row.label, row.path])).toEqual([
      ["app/src/main", "app/src/main"],
    ])
    const open = visibleRows(directories, new Set(["app/src/main"]))
    expect(open.map((row) => row.label)).toEqual(["app/src/main", "Main.java", "App.java"])
    expect(open[1]?.depth).toBe(1)
  })

  it("builds a search tree with synthesized ancestors, directories first", () => {
    const tree = searchTree([
      { path: "src/components/tree.tsx", kind: "file" },
      { path: "src/a.ts", kind: "file" },
      { path: "docs", kind: "directory" },
    ])
    const rows = visibleRows(tree.directories, tree.expanded)
    expect(rows.map((row) => row.label)).toEqual(["docs", "src", "components", "tree.tsx", "a.ts"])
  })
})

describe("path helpers", () => {
  it("lists ancestors and parents", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"])
    expect(ancestorsOf("top.ts")).toEqual([])
    expect(parentOf("a/b/c.ts")).toBe("a/b")
    expect(parentOf("top.ts")).toBe("")
  })

  it("finds substring matches first, then subsequence matches", () => {
    expect(fuzzyIndices("file-tree.tsx", "tree")).toEqual([5, 6, 7, 8])
    expect(fuzzyIndices("file-tree.tsx", "ftr")).toEqual([0, 5, 6])
    expect(fuzzyIndices("file-tree.tsx", "src tree")).toEqual([5, 6, 7, 8])
    expect(fuzzyIndices("file-tree.tsx", "zz")).toEqual([])
  })

  it("maps porcelain codes to decorations and marks changed ancestors", () => {
    expect(decorationOf(" M")).toBe("modified")
    expect(decorationOf("??")).toBe("untracked")
    expect(decorationOf("A ")).toBe("added")
    expect(decorationOf(" D")).toBe("deleted")
    expect(decorationOf("R ")).toBe("renamed")
    expect(decorationOf("UU")).toBe("conflict")
    const { files, directories } = gitDecorations([
      { path: "src/lib/a.ts", status: " M" },
      { path: "new/", status: "??" },
    ])
    expect(files.get("src/lib/a.ts")).toBe("modified")
    expect(files.get("new")).toBe("untracked")
    expect([...directories].sort()).toEqual(["src", "src/lib"])
  })
})

describe("file tabs", () => {
  const empty: PanelSurfaceState = { surfaces: [], activeId: null }

  it("opens a file once and activates it again on the next open", () => {
    const one = openFileSurface(empty, "src/a.ts", "f1")
    expect(one).toEqual({
      surfaces: [{ id: "f1", kind: "file", title: "a.ts", path: "src/a.ts" }],
      activeId: "f1",
    })
    const again = openFileSurface({ ...one, activeId: null }, "src/a.ts", "f2", { line: 12 })
    expect(again.surfaces).toHaveLength(1)
    expect(again).toMatchObject({ activeId: "f1", surfaces: [{ line: 12 }] })
  })

  it("replaces the explorer tab in place when a file is opened from it", () => {
    const state: PanelSurfaceState = {
      surfaces: [
        { id: "t", kind: "terminal", title: "终端 1" },
        { id: "x", kind: "files", title: "文件" },
        { id: "d", kind: "diff", title: "Diff" },
      ],
      activeId: "x",
    }
    const next = openFileSurface(state, "README.md", "f", { replace: "x" })
    expect(next.surfaces.map((surface) => surface.id)).toEqual(["t", "f", "d"])
    expect(next.activeId).toBe("f")
  })
})
