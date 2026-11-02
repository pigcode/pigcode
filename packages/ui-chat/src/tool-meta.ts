/** 工具调用的数据与通用解析：浏览器操作的图标与摘要、MCP 内容块、命令文本与一行摘要。 */
import { Camera, Globe, Keyboard, MousePointerClick, ScanText, type LucideIcon } from "lucide-react"
import type { MessageKey } from "@pigcode/ui-primitives"
import { browserAction } from "./tool-identity"

/** 工具调用的生命周期状态；stopped 是这一轮结束时还没完成的调用。 */
export type ToolStatus = "running" | "completed" | "failed" | "stopped"

/** 时间线里一行工具调用需要的数据。 */
export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  input: string | undefined
  output: string | undefined
  /** 事件里原样的输入与输出，渲染器按工具读取结构化字段。 */
  inputValue?: unknown
  outputValue?: unknown
  /** 开始与结束时间（事件的 createdAt），用来显示耗时。 */
  startedAt?: string | undefined
  endedAt?: string | undefined
  /** 命令的退出码；Agent 不报告时缺省。 */
  exitCode?: number | undefined
}

const BROWSER_ACTIONS: Record<string, [LucideIcon, MessageKey]> = {
  open: [Globe, "chat.tool.browser.open"],
  navigate: [Globe, "chat.tool.browser.navigate"],
  snapshot: [ScanText, "chat.tool.browser.snapshot"],
  click: [MousePointerClick, "chat.tool.browser.click"],
  type: [Keyboard, "chat.tool.browser.type"],
  press: [Keyboard, "chat.tool.browser.press"],
  scroll: [Globe, "chat.tool.browser.scroll"],
  wait_for: [Globe, "chat.tool.browser.wait"],
  evaluate: [Globe, "chat.tool.browser.evaluate"],
  screenshot: [Camera, "chat.tool.browser.screenshot"],
}

/** 浏览器操作的图标与动作文案；不认识的动作用地球图标，文案为 null（界面显示工具名）。 */
export function browserVisual(name: string): { icon: LucideIcon; label: MessageKey | null } {
  const entry = BROWSER_ACTIONS[browserAction(name) ?? ""]
  return { icon: entry?.[0] ?? Globe, label: entry?.[1] ?? null }
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 工具输出里的文字与图片（MCP 或 Anthropic 的内容块数组）；不是内容块时文字就是原输出。 */
export function toolOutputParts(output: string | undefined): { text: string; images: string[] } {
  if (!output?.trim().startsWith("[")) return { text: output ?? "", images: [] }
  let blocks: unknown
  try {
    blocks = JSON.parse(output)
  } catch {
    return { text: output, images: [] }
  }
  if (!Array.isArray(blocks)) return { text: output, images: [] }
  const texts: string[] = []
  const images: string[] = []
  for (const block of blocks as Array<Record<string, unknown> | null>) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text)
    if (block?.type !== "image") continue
    const source = block.source as Record<string, unknown> | undefined
    const data = typeof block.data === "string" ? block.data : source?.data
    const mime = typeof block.mimeType === "string" ? block.mimeType : source?.media_type
    if (typeof data === "string" && typeof mime === "string" && /^image\//.test(mime)) {
      images.push(`data:${mime};base64,${data}`)
    }
  }
  if (texts.length === 0 && images.length === 0) return { text: output, images: [] }
  return { text: texts.join("\n"), images }
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return url
  }
}

/** 浏览器工具的一行摘要：打开的网址、点击的元素、输入的文字…… */
export function browserPreview(
  tool: Pick<ToolCall, "name" | "input" | "output">,
): string | undefined {
  const action = browserAction(tool.name)
  if (!action) return undefined
  const value = parseJson(tool.input) ?? {}
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const candidate = value[key]
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
    }
    return undefined
  }
  switch (action) {
    case "open":
    case "navigate": {
      const url = pick("url")
      return url ? hostOf(url) : pick("action")
    }
    case "click":
      return pick("text", "selector", "ref")
    case "type": {
      const text = pick("text")
      const target = pick("ref", "selector")
      return text ? `"${text}"${target ? ` → ${target}` : ""}` : target
    }
    case "press":
      return pick("key")
    case "scroll":
      return pick("ref", "selector", "direction") ?? "down"
    case "wait_for":
      return pick("text", "selector", "url")
    case "evaluate":
      return pick("expression")?.split("\n")[0]
    default: {
      const text = toolOutputParts(tool.output).text
      const url = /(?:URL: |Screenshot of )(\S+)/.exec(text)?.[1]
      return url ? hostOf(url) : undefined
    }
  }
}

/** 从工具输入里挑一行最能说明意图的摘要：JSON 优先取命令、路径或查询字段。 */
export function toolPreview(input: string | undefined): string | undefined {
  if (!input) return undefined
  const value = parseJson(input)
  if (value) {
    for (const field of [
      "command",
      "cmd",
      "file_path",
      "path",
      "pattern",
      "query",
      "url",
      "description",
    ]) {
      const candidate = value[field]
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().split("\n")[0]
    }
    const command = value.command
    if (Array.isArray(command)) return commandText(input)?.split("\n")[0]
    return undefined
  }
  return input.trim().split("\n")[0]
}

/** 去掉 `bash -lc '…'` 这类外壳，只留真正执行的命令。 */
function unwrapShell(command: string): string {
  const match = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/i.exec(command.trim())
  if (!match?.[1]) return command.trim()
  const inner = match[1].trim()
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner)
  return (quoted?.[2] ?? inner).trim()
}

/** 命令工具执行的完整命令；输入可能是字符串、JSON 里的字符串，或 argv 数组。 */
export function commandText(input: string | undefined): string | undefined {
  if (!input) return undefined
  const value = parseJson(input)
  if (!value) return unwrapShell(input)
  const command = value.command ?? value.cmd
  if (typeof command === "string") return unwrapShell(command)
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const parts = command as string[]
    const shell = parts.findIndex((part) => part === "-lc" || part === "-c")
    if (shell >= 0 && parts[shell + 1]) return parts[shell + 1]!.trim()
    return parts.join(" ")
  }
  return undefined
}
