/** 验证资源管理器组件：按需加载、展开收起、键盘操作、搜索、git 标记与右键菜单。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileExplorer, type ExplorerListing } from "./file-explorer"
import type { ExplorerEntry } from "./file-tree-model"

afterEach(cleanup)

const TREE: Record<string, ExplorerEntry[]> = {
  "": [
    { path: "dist", name: "dist", kind: "directory", ignored: true },
    { path: "src", name: "src", kind: "directory" },
    { path: "README.md", name: "README.md", kind: "file" },
  ],
  src: [
    { path: "src/lib", name: "lib", kind: "directory" },
    { path: "src/index.ts", name: "index.ts", kind: "file" },
  ],
  "src/lib": [{ path: "src/lib/util.ts", name: "util.ts", kind: "file" }],
}

function setup(overrides: Partial<Parameters<typeof FileExplorer>[0]> = {}) {
  const loadDirectory = vi.fn(async (path: string): Promise<ExplorerListing> => ({
    entries: TREE[path] ?? [],
    truncated: false,
  }))
  const searchPaths = vi.fn(async (query: string) => ({
    entries: query === "util" ? [{ path: "src/lib/util.ts", kind: "file" as const }] : [],
    truncated: false,
  }))
  const onOpenFile = vi.fn()
  render(
    <FileExplorer
      rootName="demo"
      loadDirectory={loadDirectory}
      searchPaths={searchPaths}
      onOpenFile={onOpenFile}
      {...overrides}
    />,
  )
  return { loadDirectory, searchPaths, onOpenFile }
}

const labels = () => screen.queryAllByRole("treeitem").map((item) => item.textContent)

describe("FileExplorer", () => {
  it("loads the root, then directories as they are expanded", async () => {
    const { loadDirectory, onOpenFile } = setup()
    await waitFor(() => expect(labels()).toEqual(["dist", "src", "README.md"]))
    expect(screen.getByRole("treeitem", { name: "dist" }).dataset.ignored).toBe("true")
    expect(loadDirectory).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole("treeitem", { name: "src" }))
    await waitFor(() => expect(labels()).toEqual(["dist", "src", "lib", "index.ts", "README.md"]))
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe("true")

    await userEvent.click(screen.getByRole("treeitem", { name: "index.ts" }))
    expect(onOpenFile).toHaveBeenCalledWith("src/index.ts")
    await userEvent.click(screen.getByRole("treeitem", { name: "src" }))
    expect(labels()).toEqual(["dist", "src", "README.md"])
  })

  it("navigates with the keyboard", async () => {
    const { onOpenFile } = setup()
    await waitFor(() => expect(labels()).toHaveLength(3))
    const tree = screen.getByRole("tree")
    // 聚焦树时落在第一行。
    act(() => tree.focus())
    expect(tree.getAttribute("aria-activedescendant")).toMatch(/dist$/)
    fireEvent.keyDown(tree, { key: "ArrowDown" })
    expect(tree.getAttribute("aria-activedescendant")).toMatch(/src$/)
    fireEvent.keyDown(tree, { key: "ArrowRight" })
    await waitFor(() => expect(labels()).toContain("index.ts"))
    fireEvent.keyDown(tree, { key: "ArrowRight" })
    fireEvent.keyDown(tree, { key: "ArrowDown" })
    fireEvent.keyDown(tree, { key: "Enter" })
    expect(onOpenFile).toHaveBeenCalledWith("src/index.ts")
    fireEvent.keyDown(tree, { key: "ArrowLeft" })
    expect(tree.getAttribute("aria-activedescendant")).toMatch(/src$/)
    fireEvent.keyDown(tree, { key: "ArrowLeft" })
    await waitFor(() => expect(labels()).not.toContain("index.ts"))
  })

  it("reveals the active file by expanding its ancestors", async () => {
    setup({ activePath: "src/lib/util.ts" })
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "util.ts" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    )
    expect(labels()).toEqual(["dist", "src", "lib", "util.ts", "index.ts", "README.md"])
  })

  it("searches paths and shows matches inside their folders", async () => {
    const { searchPaths } = setup()
    await waitFor(() => expect(labels()).toHaveLength(3))
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索文件" }), "util")
    await waitFor(() => expect(labels()).toEqual(["src/lib", "util.ts"]))
    expect(searchPaths).toHaveBeenLastCalledWith("util")
    expect(screen.getByRole("treeitem", { name: "util.ts" }).querySelectorAll("mark")).toHaveLength(
      4,
    )
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索文件" }))
    await waitFor(() => expect(labels()).toEqual(["dist", "src", "README.md"]))
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索文件" }), "zzz")
    expect(await screen.findByText("没有匹配的文件")).toBeTruthy()
  })

  it("shows git decorations and forwards the context menu", async () => {
    const onContextMenu = vi.fn()
    setup({
      git: { files: new Map([["README.md", "modified" as const]]), directories: new Set(["src"]) },
      onContextMenu,
    })
    await waitFor(() => expect(labels()).toHaveLength(3))
    const readme = screen.getByRole("treeitem", { name: "README.md" })
    expect(readme.dataset.git).toBe("modified")
    expect(readme.querySelector(".fx-git")?.textContent).toBe("M")
    expect(screen.getByRole("treeitem", { name: "src" }).querySelector(".fx-git-dot")).toBeTruthy()
    fireEvent.contextMenu(readme, { clientX: 10, clientY: 20 })
    expect(onContextMenu).toHaveBeenCalledWith(
      { path: "README.md", kind: "file" },
      { x: 10, y: 20 },
    )
  })

  it("re-reads open directories when the revision changes", async () => {
    const loadDirectory = vi.fn(async (path: string) => ({
      entries: TREE[path] ?? [],
      truncated: false,
    }))
    const props = {
      rootName: "demo",
      loadDirectory,
      searchPaths: async () => ({ entries: [], truncated: false }),
      onOpenFile: () => undefined,
    }
    const { rerender } = render(<FileExplorer {...props} revision={1} />)
    await waitFor(() => expect(labels()).toHaveLength(3))
    await userEvent.click(screen.getByRole("treeitem", { name: "src" }))
    await waitFor(() => expect(labels()).toContain("index.ts"))
    loadDirectory.mockClear()
    rerender(<FileExplorer {...props} revision={2} />)
    await waitFor(() =>
      expect(loadDirectory.mock.calls.map(([path]) => path).sort()).toEqual(["", "src"]),
    )
  })
})
