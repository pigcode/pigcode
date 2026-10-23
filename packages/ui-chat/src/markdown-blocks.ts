/**
 * Markdown 的块级解析（CommonMark 与 GFM 的常用子集）：标题（含 setext）、段落、代码围栏、
 * 引用（可嵌套）、有序与无序列表（按缩进嵌套，支持任务项）、表格与分隔线。
 * 未闭合的代码围栏把剩余内容都当作代码，适配流式输出。
 */

/** 表格一列的对齐方式。 */
export type Align = "left" | "center" | "right" | null

/** 列表的一项；task 为 null 表示不是任务项。 */
export interface ListItem {
  task: boolean | null
  blocks: Block[]
}

/** 一个块。 */
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "code"; lang: string; text: string; closed: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; align: Align[]; header: string[]; rows: string[][] }
  | { kind: "rule" }

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const SETEXT = /^\s{0,3}(=+|-+)\s*$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const TASK = /^\[([ xX])\]\s+/

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].replace(/\t/g, "    ").length ?? 0
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? ""
  const delimiter = lines[index + 1] ?? ""
  return header.includes("|") && delimiter.includes("-") && TABLE_DELIMITER.test(delimiter)
}

/** 判断一行是否开启新的块，段落遇到它就结束。 */
function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ""
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, index)
  )
}

/** 表格的一行拆成单元格；`\|` 是单元格里的竖线。 */
export function tableCells(line: string): string[] {
  const trimmed = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"))
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":")
  const right = cell.endsWith(":")
  return left && right ? "center" : right ? "right" : left ? "left" : null
}

function parseFence(lines: readonly string[], start: number): { block: Block; next: number } {
  const open = FENCE.exec(lines[start] ?? "")!
  const indent = open[1]?.length ?? 0
  const marker = open[2] ?? "```"
  const body: string[] = []
  let index = start + 1
  let closed = false
  while (index < lines.length) {
    const line = lines[index] ?? ""
    const trimmed = line.trim()
    if (trimmed.startsWith(marker[0]!.repeat(marker.length)) && /^(`+|~+)$/.test(trimmed)) {
      closed = true
      index += 1
      break
    }
    body.push(indent > 0 ? line.replace(new RegExp(`^ {0,${indent}}`), "") : line)
    index += 1
  }
  return {
    block: { kind: "code", lang: open[3] ?? "", text: body.join("\n"), closed },
    next: index,
  }
}

function parseList(lines: readonly string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? "")!
  const base = indentOf(first[1] ?? "")
  const ordered = /\d/.test(first[2] ?? "")
  const items: ListItem[] = []
  let index = start
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index] ?? "")
    if (!match || indentOf(match[1] ?? "") !== base || /\d/.test(match[2] ?? "") !== ordered) break
    if (RULE.test(lines[index] ?? "")) break
    const contentIndent = base + (match[2]?.length ?? 1) + Math.max(1, match[3]?.length ?? 1)
    const body = [match[4] ?? ""]
    index += 1
    while (index < lines.length) {
      const line = lines[index] ?? ""
      if (line.trim() === "") {
        let ahead = index + 1
        while (ahead < lines.length && (lines[ahead] ?? "").trim() === "") ahead += 1
        if (ahead < lines.length && indentOf(lines[ahead] ?? "") > base) {
          body.push("")
          index += 1
          continue
        }
        break
      }
      if (indentOf(line) > base) {
        body.push(line.slice(Math.min(contentIndent, indentOf(line))))
        index += 1
        continue
      }
      if (!startsBlock(lines, index) && (body.at(-1) ?? "").trim() !== "") {
        body.push(line.trim())
        index += 1
        continue
      }
      break
    }
    const task = TASK.exec(body[0] ?? "")
    if (task) body[0] = (body[0] ?? "").slice(task[0].length)
    items.push({ task: task ? task[1] !== " " : null, blocks: parseBlocks(body.join("\n")) })
  }
  const start0 = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1
  return { block: { kind: "list", ordered, start: start0, items }, next: index }
}

function parseTable(lines: readonly string[], start: number): { block: Block; next: number } {
  const header = tableCells(lines[start] ?? "")
  const align = tableCells(lines[start + 1] ?? "").map(alignOf)
  const rows: string[][] = []
  let index = start + 2
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trim() === "" || !line.includes("|")) break
    const cells = tableCells(line)
    rows.push(header.map((_, column) => cells[column] ?? ""))
    index += 1
  }
  return {
    block: { kind: "table", align: header.map((_, column) => align[column] ?? null), header, rows },
    next: index,
  }
}

/** 把文本切成块。 */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trim() === "") {
      index += 1
      continue
    }
    if (FENCE.test(line)) {
      const { block, next } = parseFence(lines, index)
      blocks.push(block)
      index = next
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ kind: "heading", level, text: heading[2] ?? "" })
      index += 1
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" })
      index += 1
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ""
        const quoted = QUOTE.exec(current)
        if (quoted) body.push(quoted[1] ?? "")
        else if (current.trim() !== "" && body.length > 0 && !startsBlock(lines, index)) {
          body.push(current)
        } else break
        index += 1
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(body.join("\n")) })
      continue
    }
    if (LIST_ITEM.test(line) && (LIST_ITEM.exec(line)?.[4] ?? "").trim() !== "") {
      const { block, next } = parseList(lines, index)
      blocks.push(block)
      index = next
      continue
    }
    if (isTableStart(lines, index)) {
      const { block, next } = parseTable(lines, index)
      blocks.push(block)
      index = next
      continue
    }
    const body: string[] = [line]
    index += 1
    while (index < lines.length) {
      const current = lines[index] ?? ""
      const setext = SETEXT.exec(current)
      if (setext && /\S/.test(body.join(""))) {
        blocks.push({
          kind: "heading",
          level: setext[1]?.startsWith("=") ? 1 : 2,
          text: body.join(" ").trim(),
        })
        body.length = 0
        index += 1
        break
      }
      if (current.trim() === "" || startsBlock(lines, index)) break
      body.push(current)
      index += 1
    }
    if (body.length > 0) blocks.push({ kind: "paragraph", text: body.join("\n") })
  }
  return blocks
}
