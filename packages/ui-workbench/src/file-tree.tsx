/** 文件树：把 Host 返回的扁平路径构建成目录树，点击文件时回调。 */
import { useMemo, useState } from "react"

/** 工作区文件条目；目录由路径前缀推导，type 保留 Host 的原始声明。 */
export interface FileTreeEntry {
  path: string
  type?: "file"
}

/** 文件树属性；选中项由父组件控制。 */
export interface FileTreeProps {
  entries: readonly FileTreeEntry[]
  onSelect: (path: string) => void
  selectedPath?: string | null
  emptyText?: string
}

/** 构建阶段的可变树节点。 */
interface MutableNode {
  name: string
  path: string
  isFile: boolean
  children: Map<string, MutableNode>
}

/** 渲染阶段的只读树节点。 */
interface TreeNode {
  name: string
  path: string
  isFile: boolean
  children: TreeNode[]
}

/** 把相对路径拆成非空片段；Host 已校验根目录，这里只做展示层规整。 */
function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0 && part !== ".")
}

/** 将可变节点按目录优先、名称升序转换为只读树。 */
function freezeNodes(nodes: Map<string, MutableNode>): TreeNode[] {
  return [...nodes.values()]
    .map((node) => ({
      name: node.name,
      path: node.path,
      isFile: node.isFile,
      children: freezeNodes(node.children),
    }))
    .sort((left, right) => {
      if (left.isFile !== right.isFile) return left.isFile ? 1 : -1
      return left.name.localeCompare(right.name)
    })
}

/** 由扁平文件列表构建目录树。 */
function buildTree(entries: readonly FileTreeEntry[]): TreeNode[] {
  const root = new Map<string, MutableNode>()
  for (const entry of entries) {
    const segments = splitPath(entry.path)
    let level = root
    let currentPath = ""
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]
      if (name === undefined) continue
      currentPath = currentPath.length > 0 ? `${currentPath}/${name}` : name
      let node = level.get(name)
      if (!node) {
        node = { name, path: currentPath, isFile: false, children: new Map() }
        level.set(name, node)
      }
      if (index === segments.length - 1 && (entry.type ?? "file") === "file") {
        node.isFile = true
      }
      level = node.children
    }
  }
  return freezeNodes(root)
}

/** 单个树节点；目录可折叠，文件可选中。 */
function TreeBranch({
  node,
  depth,
  collapsed,
  selectedPath,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  depth: number
  collapsed: ReadonlySet<string>
  selectedPath: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const indent = { paddingLeft: `${depth * 14 + 6}px` }
  if (node.isFile && node.children.length === 0) {
    const selected = node.path === selectedPath
    return (
      <li role="treeitem" aria-selected={selected}>
        <button
          type="button"
          className={selected ? "file-tree-item file-tree-item-active" : "file-tree-item"}
          style={indent}
          title={node.path}
          onClick={() => onSelect(node.path)}
        >
          {node.name}
        </button>
      </li>
    )
  }
  const expanded = !collapsed.has(node.path)
  return (
    <li role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className="file-tree-dir"
        style={indent}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <span className="file-tree-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        {node.name}
      </button>
      {expanded ? (
        <ul role="group" className="file-tree-group">
          {node.children.map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** 文件树入口；默认展开全部目录，折叠状态按路径记录。 */
export function FileTree({
  entries,
  onSelect,
  selectedPath = null,
  emptyText = "暂无文件",
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(entries), [entries])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  function toggle(path: string): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (tree.length === 0) return <p className="workbench-empty">{emptyText}</p>

  return (
    <ul role="tree" className="file-tree" aria-label="工作区文件">
      {tree.map((node) => (
        <TreeBranch
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapsed}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}
