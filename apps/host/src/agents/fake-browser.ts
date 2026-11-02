/**
 * fake agent 的浏览器脚本：输入「browser <网址>」时，像真的 agent 一样调用内置浏览器的
 * MCP 工具——打开页面、读快照、填表单、点登录、等结果、截图，最后总结。用来在没有真实 CLI 的
 * 环境里演示和测试 agent 操作浏览器。
 */
import type { AgentRuntime } from "./driver"

/** 触发浏览器脚本的输入前缀。 */
export const FAKE_BROWSER_PREFIX = "browser "

/** 以线程身份调用一个 MCP 工具。 */
export type FakeToolCaller = (threadId: string, name: string, input: unknown) => Promise<unknown>

/** 工具结果里的文字与原样输出（图片保留为 MCP 内容块）。 */
function outputOf(result: unknown): { text: string; output: unknown } {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return { text: JSON.stringify(result), output: result }
  const text = content
    .filter((item): item is { type: "text"; text: string } => item?.type === "text")
    .map((item) => item.text)
    .join("\n")
  const hasImage = content.some((item) => item?.type === "image")
  return { text, output: hasImage ? content : text }
}

/** 从快照里按标签找元素 ref。 */
function findRef(snapshot: string, role: string, labels: string[]): string | undefined {
  for (const line of snapshot.split("\n")) {
    const match = /^\[(e\d+)\] (\S+)(?: "([^"]*)")?/.exec(line)
    if (!match || match[2] !== role) continue
    const label = (match[3] ?? "").toLowerCase()
    if (labels.some((wanted) => label.includes(wanted))) return match[1]
  }
  return undefined
}

async function say(runtime: AgentRuntime, text: string, stepMs: number): Promise<void> {
  for (const word of text.split(/(?<=\s)/)) {
    runtime.emit({ type: "message.delta", text: word })
    if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(30, stepMs / 10)))
  }
  runtime.emit({ type: "message.completed", text })
}

/** 跑一遍浏览器脚本；任何一步失败就说明原因并结束。 */
export async function runFakeBrowser(
  runtime: AgentRuntime,
  options: { threadId: string; url: string; stepMs: number; callTool: FakeToolCaller | undefined },
): Promise<void> {
  const { threadId, url, stepMs, callTool } = options
  let seq = 0
  const pause = () => new Promise((resolve) => setTimeout(resolve, stepMs / 2))
  const call = async (tool: string, input: Record<string, unknown>): Promise<string> => {
    const toolCallId = `fake-browser-${(seq += 1)}`
    const name = `mcp__pigcode__${tool}`
    runtime.emit({ type: "tool.started", toolCallId, name, input })
    try {
      if (!callTool) throw new Error("MCP tools are not available")
      const { text, output } = outputOf(await callTool(threadId, tool, input))
      runtime.emit({ type: "tool.completed", toolCallId, name, output, isError: false })
      await pause()
      return text
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      runtime.emit({ type: "tool.completed", toolCallId, name, output: message, isError: true })
      throw error
    }
  }

  await say(runtime, `我在内置浏览器里打开 ${url}，走一遍登录流程。`, stepMs)
  try {
    await call("browser_open", { url })
    if (runtime.signal.aborted) return
    const snapshot = await call("browser_snapshot", {})
    const email = findRef(snapshot, "textbox", ["邮箱", "email"])
    const password = findRef(snapshot, "textbox", ["密码", "password"])
    const submit = findRef(snapshot, "button", ["登录", "sign in", "log in"])
    if (!email || !password || !submit) {
      await say(runtime, "页面上没有找到登录表单，快照里的元素如上。", stepMs)
      return
    }
    await say(
      runtime,
      `找到了邮箱（${email}）、密码（${password}）和登录按钮（${submit}）。`,
      stepMs,
    )
    await call("browser_type", { ref: email, text: "demo@pigcode.dev", clear: true })
    await call("browser_type", { ref: password, text: "pigcode-demo", clear: true })
    if (runtime.signal.aborted) return
    await call("browser_click", { ref: submit })
    await call("browser_wait_for", { text: "欢迎", timeoutMs: 5000 })
    await call("browser_screenshot", {})
    await say(
      runtime,
      "登录流程正常：\n\n- 邮箱和密码输入后点「登录」，页面跳到欢迎页\n- 欢迎页显示了登录的邮箱\n- 截图已附在上面",
      stepMs,
    )
  } catch (error) {
    if (runtime.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    await say(runtime, `浏览器操作失败：${message}`, stepMs)
  }
}
