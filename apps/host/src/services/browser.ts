/**
 * 内置浏览器的 MCP 工具：agent 调用 browser_* 时，经 main 进程的控制端口在该线程的浏览器里执行。
 * 浏览器显示在右栏，用户能看到 agent 打开了什么、点了哪里。没有控制端口（测试、无界面运行）时
 * 工具返回说明，不会挂起。
 */
import type { Context } from "cordis"
import type { McpToolDefinition } from "@pigcode/plugin-sdk"

/** 一次浏览器动作的结果：给 agent 的文字，截图时带图。 */
export interface BrowserResult {
  text: string
  image?: { data: string; mimeType: string }
}

/** utilityProcess 控制端口的最小接口；Electron 交来的是带 data 的 MessageEvent。 */
export interface ControlPortLike {
  on(event: "message", listener: (event: unknown) => void): unknown
  postMessage(message: unknown): void
  start?(): void
}

/** 浏览器服务；entry 把控制端口交给它。 */
export interface BrowserService {
  attach(port: ControlPortLike): void
  call(threadId: string, action: string, params: Record<string, unknown>): Promise<BrowserResult>
}

declare module "cordis" {
  interface Context {
    browser: BrowserService
  }
}

export const inject = ["mcpBridge"]

const TIMEOUT_MS = 60_000

const target = {
  ref: { type: "string", description: "Element ref from the latest browser_snapshot, e.g. e3" },
  selector: { type: "string", description: "CSS selector, when there is no ref" },
}

/** 工具定义；action 是交给 main 执行的动作名。 */
export const BROWSER_TOOLS: Array<McpToolDefinition & { action: string }> = [
  {
    name: "browser_open",
    action: "open",
    description:
      "Open Pigcode's built-in browser for this conversation, optionally at a URL (e.g. your dev server at http://localhost:5173). The user sees it in the right panel. Returns the page URL and title.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL; localhost:3000 also works" },
      },
    },
  },
  {
    name: "browser_navigate",
    action: "navigate",
    description: "Go to a URL in the built-in browser, or go back, forward or reload.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        action: { type: "string", enum: ["back", "forward", "reload"] },
      },
    },
  },
  {
    name: "browser_snapshot",
    action: "snapshot",
    description:
      "Read the current page: URL, title, headings, interactive elements with refs (e1, e2, …) and visible text. Snapshot before clicking or typing and again after the page changes; refs only hold for the latest snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    action: "click",
    description:
      "Click an element by ref (preferred), CSS selector or visible text. Waits for any navigation it causes.",
    inputSchema: {
      type: "object",
      properties: {
        ...target,
        text: { type: "string", description: "Visible text or label of the element" },
        double: { type: "boolean", description: "Double-click" },
      },
    },
  },
  {
    name: "browser_type",
    action: "type",
    description:
      "Type text into an input, textarea or editable element (by ref or selector; the focused element otherwise). clear=true replaces what is there, submit=true presses Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        ...target,
        text: { type: "string" },
        clear: { type: "boolean" },
        submit: { type: "boolean" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_press",
    action: "press",
    description:
      "Press a key or shortcut in the page, e.g. Enter, Escape, Tab, ArrowDown, Control+A.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    action: "scroll",
    description:
      "Scroll the page up or down by viewports (amount, default 1), or scroll an element (ref or selector) into view.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number" },
        ...target,
      },
    },
  },
  {
    name: "browser_wait_for",
    action: "wait_for",
    description:
      "Wait until the page shows some text, a CSS selector matches, or the URL contains a string. Default timeout 10 s, at most 30 s.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        url: { type: "string" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_evaluate",
    action: "evaluate",
    description:
      "Run a JavaScript expression in the page and return its JSON-serialisable result (up to 20 KB). Use it for details the snapshot does not show.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
  {
    name: "browser_screenshot",
    action: "screenshot",
    description:
      "Capture what the browser shows as an image, to check layout and visuals. Prefer browser_snapshot for reading content.",
    inputSchema: { type: "object", properties: {} },
  },
]

/** 把结果转成 MCP 的内容块。 */
export function toMcpContent(result: BrowserResult): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
} {
  return {
    content: [
      ...(result.image
        ? [{ type: "image" as const, data: result.image.data, mimeType: result.image.mimeType }]
        : []),
      { type: "text" as const, text: result.text },
    ],
  }
}

function isResponse(value: unknown): value is {
  type: "browser.response"
  id: number
  ok: boolean
  result?: BrowserResult
  error?: string
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "browser.response" &&
    typeof (value as { id?: unknown }).id === "number"
  )
}

/** 注册浏览器服务与 MCP 工具。 */
export function apply(ctx: Context): void {
  let port: ControlPortLike | null = null
  let nextId = 1
  const pending = new Map<
    number,
    {
      resolve: (result: BrowserResult) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  const service: BrowserService = {
    attach(next) {
      port = next
      next.on("message", (event) => {
        const message =
          typeof event === "object" && event !== null && "data" in event
            ? (event as { data: unknown }).data
            : event
        if (!isResponse(message)) return
        const waiter = pending.get(message.id)
        if (!waiter) return
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.ok && message.result) waiter.resolve(message.result)
        else waiter.reject(new Error(message.error ?? "browser action failed"))
      })
      next.start?.()
    },
    call(threadId, action, params) {
      const current = port
      if (!current) {
        return Promise.reject(
          new Error("The built-in browser is only available in the Pigcode desktop app."),
        )
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The browser did not answer within ${TIMEOUT_MS / 1000} seconds.`))
        }, TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        current.postMessage({ type: "browser.request", id, threadId, action, params })
      })
    },
  }
  ctx.provide("browser", service)

  for (const { action, ...tool } of BROWSER_TOOLS) {
    const dispose = ctx.mcpBridge.registerTool("core.browser", tool, async (input, context) => {
      const params =
        typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
      return toMcpContent(await service.call(context.threadId, action, params))
    })
    ctx.effect(() => dispose)
  }
  ctx.effect(() => () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("The browser service stopped."))
    }
    pending.clear()
  })
}

apply.inject = inject
