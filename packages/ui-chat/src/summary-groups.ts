/**
 * 连续摘要组（对齐 ZCode 4.0.0 并收拢 Claude Code 工具链，见 pigcode/monorepo#129）：
 * 连续两项以上的思考、查阅（读文件、搜索、ToolSearch、网页抓取、LSP、只读会话读取）、
 * 执行（终端命令、浏览器操作、MCP、Skill、后台任务输出/停止、会话写操作）和修改
 * （写入、编辑、补丁）合成一组；过程正文、子 agent、工作流、计划卡、提问与未知工具是边界，
 * 照常单独显示。思考只进组、不计数。
 */
import { fileChanges } from "./file-changes"
import { isReadOnlySessionTool, isSessionWriteTool, toolFamily } from "./tool-identity"
import type { ToolCall } from "./tool-meta"
import type { WorkItem } from "./turns"

/** 摘要组里的三类工具。 */
export type SummaryCategory = "explore" | "run" | "change"

/** 工具在摘要组里算哪一类；null 表示它不进组。 */
export function summaryCategory(tool: ToolCall): SummaryCategory | null {
  if (isReadOnlySessionTool(tool.name)) return "explore"
  if (isSessionWriteTool(tool.name)) return "run"
  const family = toolFamily(tool.name)
  if (family === "file-read" || family === "search" || family === "web-fetch") return "explore"
  if (
    family === "shell" ||
    family === "browser" ||
    family === "mcp" ||
    family === "skill" ||
    family === "task-output" ||
    family === "task-stop"
  ) {
    return "run"
  }
  if (family === "file-write") return "change"
  return null
}

function joinsSummary(item: WorkItem): boolean {
  if (item.kind === "reasoning") return true
  return item.kind === "tool" && summaryCategory(item.tool) !== null
}

/** 工作区里的一项：原样的工作，或者一组连续的摘要。 */
export type WorkEntry = WorkItem | { kind: "group"; key: string; items: WorkItem[] }

/** 把连续两项以上能进组的工作合成一组；只有一项时照常单独显示。组的 key 跟着第一项，追加时不变。 */
export function groupSummaries(items: readonly WorkItem[]): WorkEntry[] {
  const entries: WorkEntry[] = []
  let run: WorkItem[] = []
  const flush = () => {
    if (run.length >= 2) entries.push({ kind: "group", key: `group-${run[0]!.key}`, items: run })
    else entries.push(...run)
    run = []
  }
  for (const item of items) {
    if (joinsSummary(item)) {
      run.push(item)
      continue
    }
    flush()
    entries.push(item)
  }
  flush()
  return entries
}

/** 去掉 `.`、`..` 和重复的分隔符，项目内的相对路径接上项目目录；只按字面比较，不读文件系统。 */
export function summaryPath(path: string, root?: string): string {
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(path)
  const joined = (root && !absolute ? `${root}/${path}` : path).replaceAll("\\", "/")
  const head = /^[a-z]:\//i.exec(joined)?.[0] ?? (joined.startsWith("/") ? "/" : "")
  const parts: string[] = []
  for (const part of joined.slice(head.length).split("/")) {
    if (!part || part === ".") continue
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop()
    else if (part !== ".." || !head) parts.push(part)
  }
  return head + parts.join("/")
}

/** 组里的计数：查阅几项、执行几次、改了哪些文件，以及说不出改了哪个文件的修改次数。 */
export interface SummaryCounts {
  explore: number
  run: number
  /** 改过的文件，去重后按第一次出现的顺序。 */
  files: string[]
  unresolved: number
}

/** 统计一组里的工具；每次调用算一项，改动按文件去重，失败和停下的调用也算在内。 */
export function summaryCounts(items: readonly WorkItem[], root?: string): SummaryCounts {
  const counts: SummaryCounts = { explore: 0, run: 0, files: [], unresolved: 0 }
  const seen = new Set<string>()
  for (const item of items) {
    if (item.kind !== "tool") continue
    const category = summaryCategory(item.tool)
    if (category === "explore") counts.explore += 1
    else if (category === "run") counts.run += 1
    else if (category === "change") {
      const paths = fileChanges(item.tool)
        .map((change) => change.path)
        .filter(Boolean)
      if (paths.length === 0) counts.unresolved += 1
      for (const path of paths) {
        const key = summaryPath(path, root)
        if (seen.has(key)) continue
        seen.add(key)
        counts.files.push(path)
      }
    }
  }
  return counts
}

/** 组里正在进行的一项：最后一个还在跑的工具，或者还在输出的思考。 */
export function activeSummaryItem(items: readonly WorkItem[]): WorkItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (
      item.kind === "reasoning"
        ? item.streaming
        : item.kind === "tool" && item.tool.status === "running"
    )
      return item
  }
  return undefined
}

/** 组头的代表图标取哪一项：浏览器操作 > 修改 > 执行 > 查阅，同一类取最先出现的；只有思考时没有。 */
export function summaryIconItem(items: readonly WorkItem[]): WorkItem | undefined {
  let chosen: WorkItem | undefined
  let rank = Infinity
  for (const item of items) {
    if (item.kind !== "tool") continue
    const category = summaryCategory(item.tool)
    if (!category) continue
    const itemRank =
      toolFamily(item.tool.name) === "browser"
        ? 0
        : category === "change"
          ? 1
          : category === "run"
            ? 2
            : 3
    if (itemRank < rank) {
      chosen = item
      rank = itemRank
    }
  }
  return chosen
}
