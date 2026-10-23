/**
 * 写文件类工具的改动：Claude 的 Edit / MultiEdit / Write / NotebookEdit、Codex 的 ApplyPatch，
 * 统一成「文件 + 增删行数 + 预览行」，供编辑行、文件改动汇总与内联 diff 使用。
 */
import { structuredPatch } from "diff"
import { toolFamily } from "./tool-identity"
import type { ToolCall } from "./tool-meta"

/** 内联 diff 的一行；gap 表示省略或两段改动之间的分隔。 */
export interface DiffLine {
  kind: "add" | "remove" | "context" | "gap"
  text: string
  /** 改动后文件里的行号；只有带 hunk 头的补丁才知道。 */
  line?: number | undefined
}

/** 一个文件的改动。 */
export interface FileChange {
  path: string
  operation: "write" | "edit" | "delete"
  added: number
  removed: number
  lines: DiffLine[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** 工具输入：优先用事件里的结构化值，旧数据从 JSON 文本解析。 */
export function toolInputValue(tool: Pick<ToolCall, "input" | "inputValue">): unknown {
  if (tool.inputValue !== undefined) return tool.inputValue
  const text = tool.input?.trim()
  if (!text || !/^[[{]/.test(text)) return tool.input
  try {
    return JSON.parse(text) as unknown
  } catch {
    return tool.input
  }
}

function pathOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "filePath", "notebook_path", "filename"]) {
    const value = asString(record[key])?.trim()
    if (value) return value
  }
  return undefined
}

function splitLines(text: string): string[] {
  if (text === "") return []
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")
}

/** 两段文字之间的行级改动，保留三行上下文。 */
function snippetDiff(before: string, after: string): DiffLine[] {
  const patch = structuredPatch("a", "b", before, after, "", "", { context: 3 })
  const lines: DiffLine[] = []
  for (const [index, hunk] of patch.hunks.entries()) {
    if (index > 0) lines.push({ kind: "gap", text: "" })
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context"
      lines.push({ kind, text: line.slice(1) })
    }
  }
  return lines
}

/** 统一 diff 文本（可能带 @@ hunk 头）转成预览行，带上新文件里的行号。 */
export function unifiedDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let next: number | undefined
  for (const raw of splitLines(diff)) {
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ")) continue
    if (raw.startsWith("index ") || raw.startsWith("\\")) continue
    if (raw.startsWith("@@")) {
      // apply_patch 的 hunk 头只有 `@@` 或 `@@ 上下文`，不带行号。
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (lines.length > 0) lines.push({ kind: "gap", text: "" })
      next = hunk ? Number(hunk[1]) : undefined
      continue
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), line: next })
      if (next !== undefined) next += 1
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "remove", text: raw.slice(1) })
    } else {
      lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, line: next })
      if (next !== undefined) next += 1
    }
  }
  return lines
}

function counted(path: string, operation: FileChange["operation"], lines: DiffLine[]): FileChange {
  return {
    path,
    operation,
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
    lines,
  }
}

function addedLines(content: string): DiffLine[] {
  return splitLines(content).map((text, index) => ({ kind: "add", text, line: index + 1 }))
}

/** Codex 的 fileChange：每项带路径、类型（add/delete/update）与统一 diff 或完整内容。 */
function codexChanges(entries: unknown[]): FileChange[] {
  const changes: FileChange[] = []
  for (const entry of entries) {
    const record = asRecord(entry)
    const path = record ? pathOf(record) : undefined
    if (!record || !path) continue
    const kindValue = record.kind
    const kind = asString(kindValue) ?? asString(asRecord(kindValue)?.type) ?? "update"
    const diff = asString(record.diff) ?? asString(record.unified_diff)
    const content = asString(record.content)
    if (kind === "delete") {
      changes.push(counted(path, "delete", content ? addedLines(content).map(asRemoved) : []))
    } else if (diff !== undefined) {
      changes.push(counted(path, kind === "add" ? "write" : "edit", unifiedDiffLines(diff)))
    } else if (content !== undefined) {
      changes.push(counted(path, "write", addedLines(content)))
    }
  }
  return changes
}

function asRemoved(line: DiffLine): DiffLine {
  return { kind: "remove", text: line.text }
}

/** `*** Begin Patch` 格式的补丁（Codex apply_patch 的原始输入）。 */
function beginPatchChanges(patch: string): FileChange[] {
  const changes: FileChange[] = []
  let current: { path: string; operation: FileChange["operation"]; body: string[] } | null = null
  const flush = () => {
    if (!current) return
    const lines =
      current.operation === "write"
        ? current.body.map((line, index): DiffLine => ({
            kind: "add",
            text: line.replace(/^\+/, ""),
            line: index + 1,
          }))
        : unifiedDiffLines(current.body.join("\n"))
    changes.push(counted(current.path, current.operation, lines))
    current = null
  }
  for (const line of splitLines(patch)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      flush()
      const operation = header[1] === "Add" ? "write" : header[1] === "Delete" ? "delete" : "edit"
      current = { path: (header[2] ?? "").trim(), operation, body: [] }
    } else if (current && !line.startsWith("***")) {
      current.body.push(line)
    }
  }
  flush()
  return changes
}

/** 工具改了哪些文件；不是写文件的工具返回空数组。 */
export function fileChanges(tool: Pick<ToolCall, "name" | "input" | "inputValue">): FileChange[] {
  if (toolFamily(tool.name) !== "file-write") return []
  const value = toolInputValue(tool)
  if (Array.isArray(value)) return codexChanges(value)
  if (typeof value === "string") {
    return value.includes("*** Begin Patch") ? beginPatchChanges(value) : []
  }
  const record = asRecord(value)
  if (!record) return []
  if (Array.isArray(record.changes)) return codexChanges(record.changes)
  const patch = asString(record.patch) ?? asString(record.input)
  if (patch?.includes("*** Begin Patch")) return beginPatchChanges(patch)
  const path = pathOf(record)
  if (!path) return []
  const name = tool.name.toLowerCase()
  if (name === "notebookedit") {
    if (record.edit_mode === "delete") return [counted(path, "delete", [])]
    return [counted(path, "edit", addedLines(asString(record.new_source) ?? ""))]
  }
  if (Array.isArray(record.edits)) {
    const lines: DiffLine[] = []
    for (const edit of record.edits) {
      const item = asRecord(edit)
      if (!item) continue
      const diff = snippetDiff(asString(item.old_string) ?? "", asString(item.new_string) ?? "")
      if (diff.length === 0) continue
      if (lines.length > 0) lines.push({ kind: "gap", text: "" })
      lines.push(...diff)
    }
    return [counted(path, "edit", lines)]
  }
  if (typeof record.old_string === "string" || typeof record.new_string === "string") {
    const before = asString(record.old_string) ?? ""
    const after = asString(record.new_string) ?? ""
    return [counted(path, "edit", snippetDiff(before, after))]
  }
  if (typeof record.content === "string")
    return [counted(path, "write", addedLines(record.content))]
  if (typeof record.patch === "string")
    return [counted(path, "edit", unifiedDiffLines(record.patch))]
  return []
}

/** 一轮里改过的文件，按路径合并增删行数；保持第一次出现的顺序。 */
export function mergeFileChanges(changes: readonly FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const change of changes) {
    const existing = byPath.get(change.path)
    if (!existing) {
      byPath.set(change.path, { ...change, lines: [...change.lines] })
      continue
    }
    existing.added += change.added
    existing.removed += change.removed
    existing.operation = change.operation === "delete" ? "delete" : existing.operation
    if (change.lines.length > 0) {
      if (existing.lines.length > 0) existing.lines.push({ kind: "gap", text: "" })
      existing.lines.push(...change.lines)
    }
  }
  return [...byPath.values()]
}
