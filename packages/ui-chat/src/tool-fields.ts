/**
 * 从工具的输入输出里读出时间线需要的字段：读取的文件、搜索的内容、抓取的网址、待办、提问与回答、
 * 技能、后台任务与 MCP 调用。字段名兼容 Claude Code、Codex 与 ZCode 的写法。
 */
import { toolInputValue } from "./file-changes"
import { mcpParts, toolFamily } from "./tool-identity"
import { toolOutputParts, type ToolCall } from "./tool-meta"

type Tool = Pick<ToolCall, "name" | "input" | "inputValue" | "output" | "outputValue">

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function pick(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/** 工具输入里的对象；不是对象时为空。 */
export function inputRecord(tool: Pick<ToolCall, "input" | "inputValue">): Record<string, unknown> {
  return asRecord(toolInputValue(tool)) ?? {}
}

/** 工具输出的纯文字（MCP 内容块里的文字段落合并）。 */
export function outputText(tool: Pick<ToolCall, "output">): string {
  return toolOutputParts(tool.output).text
}

/** 路径的最后一段与父目录。 */
export function splitPath(path: string): { name: string; parent: string } {
  const clean = path.replace(/[\\/]+$/, "")
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"))
  return index < 0
    ? { name: clean, parent: "" }
    : { name: clean.slice(index + 1), parent: clean.slice(0, index) }
}

/** 读文件的目标路径。 */
export function readPath(tool: Tool): string | undefined {
  return pick(inputRecord(tool), "file_path", "filePath", "path", "notebook_path", "filename")
}

/** 搜索类工具的摘要：查找什么、列哪个目录，或网页搜索的关键词。 */
export function searchSummary(tool: Tool): { kind: "find" | "list" | "tools"; text: string } {
  const record = inputRecord(tool)
  const name = tool.name.toLowerCase()
  if (name === "toolsearch") {
    const query = pick(record, "query") ?? ""
    return {
      kind: "tools",
      text: query
        .replace(/^select:/, "")
        .split(",")
        .join(", "),
    }
  }
  if (name === "ls" || name === "list") return { kind: "list", text: pick(record, "path") ?? "" }
  const raw = toolInputValue(tool)
  if (typeof raw === "string") return { kind: "find", text: raw.trim() }
  return {
    kind: "find",
    text:
      pick(record, "search_query", "searchQuery", "query", "pattern", "path", "url", "prompt") ??
      "",
  }
}

/** 网页抓取的网址；只看 url，不显示 prompt。 */
export function fetchUrl(tool: Tool): string | undefined {
  return pick(inputRecord(tool), "url")
}

/** 待办的一项。 */
export interface TodoItem {
  text: string
  status: "pending" | "in-progress" | "completed"
}

function todoStatus(value: unknown): TodoItem["status"] {
  if (value === "completed" || value === "done") return "completed"
  if (value === "in_progress" || value === "in-progress" || value === "inProgress") {
    return "in-progress"
  }
  if (value === "active" || value === "running") return "in-progress"
  return "pending"
}

/** TodoWrite 的 todos、Codex 的 plan 或 steps 数组。 */
export function todoItems(value: unknown): TodoItem[] {
  const record = asRecord(value)
  const list = Array.isArray(value)
    ? value
    : Array.isArray(record?.todos)
      ? record.todos
      : Array.isArray(record?.plan)
        ? record.plan
        : Array.isArray(record?.steps)
          ? record.steps
          : []
  const items: TodoItem[] = []
  for (const entry of list as unknown[]) {
    if (typeof entry === "string" && entry.trim()) {
      items.push({ text: entry.trim(), status: "pending" })
      continue
    }
    const item = asRecord(entry)
    const text = pick(item, "content", "text", "step", "title", "activeForm")
    if (item && text) items.push({ text, status: todoStatus(item.status) })
  }
  return items
}

/** 提问工具的问题与回答。 */
export interface AskedQuestion {
  question: string
  header?: string | undefined
  answer: string | undefined
}

/** 从 Claude 的工具结果里读出 `"问题"="答案"`。 */
function answersFromText(text: string): Map<string, string> {
  const answers = new Map<string, string>()
  for (const match of text.matchAll(/"([^"]+)"="([^"]*)"/g)) {
    if (match[1]) answers.set(match[1], match[2] ?? "")
  }
  return answers
}

/** AskUserQuestion 的问题列表与对应回答；没有回答时 answer 为 undefined。 */
export function askedQuestions(tool: Tool): AskedQuestion[] {
  const record = inputRecord(tool)
  const given = asRecord(record.answers)
  const fromOutput = answersFromText(outputText(tool))
  const list = Array.isArray(record.questions) ? record.questions : [record]
  const questions: AskedQuestion[] = []
  for (const entry of list as unknown[]) {
    const item = asRecord(entry)
    const question = pick(item, "question")
    if (!question) continue
    const answer = pick(given, question) ?? fromOutput.get(question)
    questions.push({ question, header: pick(item, "header"), answer })
  }
  return questions
}

/** 技能名与参数。 */
export function skillFields(tool: Tool): { name: string | undefined; args: string | undefined } {
  const raw = toolInputValue(tool)
  if (typeof raw === "string") return { name: raw.trim() || undefined, args: undefined }
  const record = inputRecord(tool)
  return {
    name: pick(record, "skill", "name", "command"),
    args: pick(record, "args", "arg", "arguments", "path", "prompt", "input"),
  }
}

/** 后台任务的 id（BashOutput 的 bash_id、KillShell 的 shell_id、TaskOutput 的 task_id）。 */
export function taskId(tool: Tool): string | undefined {
  return pick(inputRecord(tool), "task_id", "taskId", "bash_id", "shell_id", "id")
}

/** BashOutput / TaskOutput 的结果：运行状态与输出文字。 */
export function taskOutput(tool: Tool): { status: string | undefined; text: string } {
  const text = outputText(tool)
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()
  const parts = [...text.matchAll(/<(stdout|stderr)>([\s\S]*?)<\/\1>/g)].map((match) =>
    (match[2] ?? "").replace(/^\n+|\n+$/g, ""),
  )
  return { status, text: parts.length > 0 ? parts.join("\n") : text.trim() }
}

/** KillShell / TaskStop 的结果说明。 */
export function taskStopMessage(tool: Tool): string | undefined {
  const text = outputText(tool).trim()
  if (!text) return undefined
  try {
    const value = asRecord(JSON.parse(text))
    return pick(value, "message") ?? text
  } catch {
    return text
  }
}

/** MCP 调用：服务、工具、参数与结果。 */
export interface McpCall {
  server: string
  tool: string
  args: Record<string, unknown> | undefined
  text: string
  images: string[]
  json: boolean
}

/** 名字里的下划线与连字符换成空格，首字母大写：`get-library-docs` → `Get library docs`。 */
export function humanizeName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

export function mcpCall(tool: Tool): McpCall | null {
  const parts = mcpParts(tool.name)
  if (!parts) return null
  const output = toolOutputParts(tool.output)
  const text = output.text.trim()
  return {
    server: parts.server,
    tool: parts.tool.startsWith(`${parts.server}_`)
      ? parts.tool.slice(parts.server.length + 1)
      : parts.tool,
    args: asRecord(toolInputValue(tool)),
    text,
    images: output.images,
    json: /^[[{]/.test(text),
  }
}

/** ExitPlanMode 交上来的计划（Markdown）。 */
export function planMarkdown(tool: Tool): string | undefined {
  return pick(inputRecord(tool), "plan")
}

/** 判断是不是需要单独展示的提问工具（和问题事件重复时由时间线隐藏）。 */
export function isAskTool(tool: Pick<ToolCall, "name">): boolean {
  return toolFamily(tool.name) === "ask-user-question"
}
