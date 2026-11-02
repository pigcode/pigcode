/**
 * driver 读取设置值与整理模型目录的纯函数；不依赖 Node，界面与 Host 都可以引用。
 * 设置值来自用户输入，读取时逐项校验类型：类型不对或留空都当作没填，回到 agent 的默认值。
 */
import {
  environmentEntriesSchema,
  reasoningEffortSchema,
  type EnvironmentEntry,
  type AgentSettingsValues,
  type ReasoningEffort,
} from "@pigcode/contracts"

/** 读取字符串设置；空白视为未填。 */
export function settingString(
  settings: AgentSettingsValues | undefined,
  key: string,
): string | undefined {
  const value = settings?.[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 读取布尔设置；不是布尔值时视为未填。 */
export function settingBoolean(
  settings: AgentSettingsValues | undefined,
  key: string,
): boolean | undefined {
  const value = settings?.[key]
  return typeof value === "boolean" ? value : undefined
}

/** 读取环境变量设置；名称不合法或重复的条目被丢弃，后写的覆盖先写的。 */
export function settingEnvironment(
  settings: AgentSettingsValues | undefined,
  key = "environment",
): EnvironmentEntry[] {
  const value = settings?.[key]
  if (!Array.isArray(value)) return []
  const byName = new Map<string, string>()
  for (const entry of value) {
    const parsed = environmentEntriesSchema.element.safeParse(entry)
    if (parsed.success) byName.set(parsed.data.name, parsed.data.value)
  }
  return [...byName].map(([name, entryValue]) => ({ name, value: entryValue }))
}

/** 按 shell 规则把一行启动参数切成 argv：支持单双引号与转义空白/引号，不做变量展开。 */
export function tokenizeCliArgs(args: string | undefined): string[] {
  const input = args?.trim()
  if (!input) return []
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let started = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ""
    if (quote) {
      if (char === quote) quote = null
      else if (char === "\\" && quote === '"' && /["\\$`]/.test(input[index + 1] ?? "")) {
        current += input[index + 1]
        index += 1
      } else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ""
      started = false
    } else if (char === "\\" && /[\s'"]/.test(input[index + 1] ?? "")) {
      // 只转义空白与引号；其余反斜杠原样保留，Windows 路径不会被吃掉。
      current += input[index + 1]
      index += 1
      started = true
    } else {
      current += char
      started = true
    }
  }
  if (started) tokens.push(current)
  return tokens
}

/** 解析后的启动参数：`--flag value`、`--flag=value` 与不带值的 `--flag`（值为 null）。 */
export interface ParsedCliArgs {
  flags: Record<string, string | null>
  positionals: string[]
}

/** 把启动参数解析成长选项与位置参数；Claude Agent SDK 的 extraArgs 就是这个形状。 */
export function parseCliArgs(args: string | readonly string[] | undefined): ParsedCliArgs {
  const tokens = typeof args === "string" || args === undefined ? tokenizeCliArgs(args) : [...args]
  const flags: Record<string, string | null> = {}
  const positionals: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf("=")
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1)
      continue
    }
    const next = tokens[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next
      index += 1
    } else flags[body] = null
  }
  return { flags, positionals }
}

/** 把 CLI 返回的档位名收窄为协议里的思考深度；无法识别时返回 null。 */
export function asReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  const alias = normalized === "extrahigh" ? "xhigh" : normalized
  const parsed = reasoningEffortSchema.safeParse(alias)
  return parsed.success ? parsed.data : null
}

/** 去重并按从低到高排序。 */
export function sortEfforts(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const unique = new Set(efforts)
  return reasoningEffortSchema.options.filter((effort) => unique.has(effort))
}
