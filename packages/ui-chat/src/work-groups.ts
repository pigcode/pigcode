/**
 * 一轮工作里连续工具的合并规则（参照 ZCode）：连续两个以上的查阅（读文件、搜索、网页抓取、
 * 只读命令）合成「查阅」，连续两个以上的终端命令合成「终端」，连续的浏览器操作合成「浏览器」。
 * 消息、思考与其他工具都会打断合并；单个工具照常单独显示。
 */
import { commandText } from "./tool-meta"
import { isReadOnlyCommand, toolFamily } from "./tool-identity"
import type { ToolCall } from "./tool-meta"

/** 可合并的分组类型。 */
export type GroupKind = "explore" | "commands" | "browser"

/** 工具属于哪种可合并的分组；其余工具不合并。 */
export function groupKindOf(tool: ToolCall): GroupKind | null {
  const family = toolFamily(tool.name)
  if (family === "file-read" || family === "search" || family === "web-fetch") return "explore"
  if (family === "browser") return "browser"
  if (family === "shell") {
    const command = commandText(tool.input) ?? ""
    return isReadOnlyCommand(command) ? "explore" : "commands"
  }
  return null
}

/** 合并后的一项：原样的条目，或者一组工具。 */
export type Grouped<T> = T | { kind: GroupKind; key: string; tools: ToolCall[] }

/** 把连续的同类工具合成一组；少于两个时保持原样。toolOf 取出条目里的工具。 */
export function groupTools<T extends { key: string }>(
  items: readonly T[],
  toolOf: (item: T) => ToolCall | null,
): Array<Grouped<T>> {
  const result: Array<Grouped<T>> = []
  let run: T[] = []
  let runKind: GroupKind | null = null
  const flush = () => {
    if (run.length >= 2 && runKind) {
      result.push({
        kind: runKind,
        key: `${runKind}-${run[0]?.key ?? ""}`,
        tools: run.map((item) => toolOf(item)).filter((tool): tool is ToolCall => tool !== null),
      })
    } else {
      result.push(...run)
    }
    run = []
    runKind = null
  }
  for (const item of items) {
    const tool = toolOf(item)
    const kind = tool ? groupKindOf(tool) : null
    if (kind) {
      if (kind !== runKind) flush()
      runKind = kind
      run.push(item)
      continue
    }
    flush()
    result.push(item)
  }
  flush()
  return result
}
