/** 验证浏览器 MCP 工具：经控制端口交给 main、截图以图片内容返回、没有桌面端时给出说明。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { BROWSER_TOOLS, apply as browser, type ControlPortLike } from "./browser"
import { toolResultContent } from "@pigcode/plugin-sdk"
import { apply as mcpBridge } from "./mcp-bridge"

/** 模拟 main 一侧：收到请求后按 action 回一个结果。 */
function fakePort(
  answer: (request: { action: string; params: unknown; threadId: string }) => unknown,
) {
  let listener: ((event: unknown) => void) | undefined
  const requests: unknown[] = []
  const port: ControlPortLike = {
    on: (_event, next) => {
      listener = next
    },
    postMessage: (message) => {
      requests.push(message)
      const request = message as { id: number; action: string; params: unknown; threadId: string }
      const reply = answer(request)
      queueMicrotask(() =>
        listener?.({
          data:
            reply instanceof Error
              ? { type: "browser.response", id: request.id, ok: false, error: reply.message }
              : { type: "browser.response", id: request.id, ok: true, result: reply },
        }),
      )
    },
    start: () => undefined,
  }
  return { port, requests }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(mcpBridge)
  await ctx.plugin(browser)
  return ctx
}

describe("browser tools", () => {
  it("registers one MCP tool per browser action", async () => {
    const ctx = await setup()
    expect(ctx.mcpBridge.listTools().map((tool) => tool.name)).toEqual(
      BROWSER_TOOLS.map((tool) => tool.name),
    )
    expect(BROWSER_TOOLS.find((tool) => tool.name === "browser_type")?.inputSchema).toMatchObject({
      required: ["text"],
    })
    await ctx.fiber.dispose()
  })

  it("explains that the browser needs the desktop app when no control port is attached", async () => {
    const ctx = await setup()
    await expect(ctx.mcpBridge.callTool("th_1", "browser_open", {})).rejects.toThrow(
      "only available in the Pigcode desktop app",
    )
    await ctx.fiber.dispose()
  })

  it("forwards calls with the thread to main and returns text and screenshots as MCP content", async () => {
    const ctx = await setup()
    const { port, requests } = fakePort(({ action }) =>
      action === "screenshot"
        ? {
            text: "Screenshot of http://localhost:4173/",
            image: { data: "AAAA", mimeType: "image/jpeg" },
          }
        : action === "click"
          ? new Error("No element matches e9.")
          : { text: "Now at http://localhost:4173/" },
    )
    ctx.browser.attach(port)

    await expect(
      ctx.mcpBridge.callTool("th_1", "browser_open", { url: "localhost:4173" }),
    ).resolves.toEqual({ content: [{ type: "text", text: "Now at http://localhost:4173/" }] })
    expect(requests[0]).toEqual({
      type: "browser.request",
      id: 1,
      threadId: "th_1",
      action: "open",
      params: { url: "localhost:4173" },
    })
    const shot = await ctx.mcpBridge.callTool("th_2", "browser_screenshot", {})
    expect(shot).toEqual({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "text", text: "Screenshot of http://localhost:4173/" },
      ],
    })
    // 交给 Claude / Codex 时图片原样保留。
    expect(toolResultContent(shot).content[0]).toEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/jpeg",
    })
    await expect(ctx.mcpBridge.callTool("th_1", "browser_click", { ref: "e9" })).rejects.toThrow(
      "No element matches e9.",
    )
    await ctx.fiber.dispose()
  })

  it("keeps plain tool results as JSON text", () => {
    expect(toolResultContent({ ok: true })).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
    })
    expect(toolResultContent({ content: [{ type: "video" }] })).toEqual({
      content: [{ type: "text", text: '{"content":[{"type":"video"}]}' }],
    })
  })
})
