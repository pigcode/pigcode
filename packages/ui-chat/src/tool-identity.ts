/**
 * 工具名到展示族的映射：时间线按族选择渲染方式（参照 ZCode 的 tool identity）。
 * Claude Code、Codex 与 ZCode 的工具名各不相同，这里统一成一套族名。
 */

/** 工具的展示族；unknown 用通用卡片显示。 */
export type ToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "web-fetch"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "task-output"
  | "task-stop"
  | "message"
  | "plan-guidance"
  | "switch-mode"
  | "mcp"
  | "browser"
  | "unknown"

const FAMILY_BY_NAME: Record<string, ToolFamily> = {
  read: "file-read",
  read_file: "file-read",
  view: "file-read",
  notebookread: "file-read",
  write: "file-write",
  edit: "file-write",
  multiedit: "file-write",
  notebookedit: "file-write",
  applypatch: "file-write",
  apply_patch: "file-write",
  str_replace_based_edit_tool: "file-write",
  bash: "shell",
  shell: "shell",
  exec: "shell",
  exec_command: "shell",
  local_shell: "shell",
  run_command: "shell",
  terminal: "shell",
  glob: "search",
  grep: "search",
  ls: "search",
  list: "search",
  find: "search",
  websearch: "search",
  web_search: "search",
  toolsearch: "search",
  webfetch: "web-fetch",
  web_fetch: "web-fetch",
  fetch: "web-fetch",
  todowrite: "todo",
  todoread: "todo",
  update_plan: "todo",
  askuserquestion: "ask-user-question",
  agent: "agent",
  task: "agent",
  spawn_agent: "agent",
  skill: "skill",
  taskoutput: "task-output",
  bashoutput: "task-output",
  taskstop: "task-stop",
  killshell: "task-stop",
  killbash: "task-stop",
  sendmessage: "message",
  enterplanmode: "plan-guidance",
  exitplanmode: "switch-mode",
  switch_mode: "switch-mode",
}

/** MCP 工具名 `mcp__server__tool` 拆出的服务与工具；不是 MCP 名字时返回 null。 */
export function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null
  const [, server = "", ...rest] = name.split("__")
  const tool = rest.join("__")
  return server && tool ? { server, tool } : null
}

/** 内置浏览器工具的动作名（open、click…）；不是浏览器工具时返回 null。 */
export function browserAction(name: string): string | null {
  const base = mcpParts(name)?.tool ?? name
  return base.startsWith("browser_") ? base.slice("browser_".length) : null
}

/** 解析工具的展示族。 */
export function toolFamily(name: string): ToolFamily {
  if (browserAction(name)) return "browser"
  if (mcpParts(name)) return "mcp"
  return FAMILY_BY_NAME[name.trim().toLowerCase()] ?? "unknown"
}

/** 时间线里不单独显示的工具：待办在状态面板里显示，进入计划模式只是内部切换。 */
export function isHiddenTool(name: string): boolean {
  const family = toolFamily(name)
  return family === "todo" || family === "plan-guidance"
}

/** 只读的终端命令（查找、列目录、看文件、看 git 状态），和读文件、搜索一起合成「查阅」。 */
const READ_ONLY_COMMAND =
  /^(?:rg|grep|egrep|fgrep|ag|ack|find|fd|ls|ll|tree|cat|head|tail|less|more|wc|stat|file|pwd|which|du|sed\s+-n|git\s+(?:status|log|show|diff|branch|blame|ls-files|rev-parse|remote))(?:\s|$)/

/** 写入或重定向的痕迹；有这些的命令不算只读。 */
const WRITE_MARK =
  /(?:^|[^>&|])>{1,2}(?!&)|\btee\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b/

/** 命令是不是只读的查阅；管道或 && 连接的每一段都要只读。 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim()
  if (!text || WRITE_MARK.test(text)) return false
  return text
    .split(/\s*(?:\|\||&&|\||;)\s*/)
    .filter(Boolean)
    .every((part) => READ_ONLY_COMMAND.test(part.replace(/^cd\s+\S+\s*$/, "pwd")))
}
