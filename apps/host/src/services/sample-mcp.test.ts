/** 验证 MCP Capability 样例：安装启用后暴露 clock_now，停用后工具消失。 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ClaudeDriver } from "@pigcode/agent-claude/driver"
import { CodexDriver } from "@pigcode/agent-codex/driver"
import type { CreateSessionInput, AgentDriver } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { apply as mcpBridge } from "./mcp-bridge"
import { buildBootGraph, installLocalPlugin } from "./plugin-manager"
import { setupHost } from "./plugin-harness"

/** 仓库内的 MCP Capability 样例目录；测试走真实的本地安装流程。 */
const CLOCK_SOURCE = fileURLToPath(
  new URL("../../../../examples/capability-clock", import.meta.url),
)

/** 安装并启用 clock 样例，返回可查询 MCP 工具的 context。 */
async function installClockSample(): Promise<{ ctx: Context; pluginId: string }> {
  const { ctx, profileDir } = await setupHost({ prefix: "pigcode-mcp-sample-", extra: [mcpBridge] })
  const plugin = await installLocalPlugin(profileDir, CLOCK_SOURCE)
  await ctx.plugins.enable(plugin.id)
  await ctx.loader.await()
  return { ctx, pluginId: plugin.id }
}

/** 等待应用在后台启动的 MCP socket 服务，确保 dispose 时能完整清理。 */
async function settleSocket(ctx: Context): Promise<void> {
  await ctx.mcpBridge.createSocketServer().catch(() => undefined)
}

describe("Capability clock sample", () => {
  it("exposes clock_now while enabled and removes it on disable", async () => {
    const { ctx, pluginId } = await installClockSample()
    try {
      expect(ctx.mcpBridge.listTools("thread-clock").map((tool) => tool.name)).toContain(
        "clock_now",
      )
      const result = (await ctx.mcpBridge.callTool("thread-clock", "clock_now", {})) as {
        now: string
      }
      // 返回值必须是可解析的 ISO 时间，而不是固定字符串。
      expect(Number.isNaN(Date.parse(result.now))).toBe(false)
      expect(result.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

      await ctx.plugins.disable(pluginId)
      await ctx.loader.await()
      expect(ctx.mcpBridge.listTools("thread-clock").map((tool) => tool.name)).not.toContain(
        "clock_now",
      )
    } finally {
      await settleSocket(ctx)
      await ctx.fiber.dispose()
    }
  })
})

describe("Capability clock sample's client code", () => {
  it("loads through the boot graph like a UI plugin's client code", async () => {
    const { ctx, profileDir } = await setupHost({
      prefix: "pigcode-mcp-sample-",
      extra: [mcpBridge],
    })
    try {
      const plugin = await installLocalPlugin(profileDir, CLOCK_SOURCE)
      expect(plugin.id).toBe("capability.pigcode-capability-clock")
      const graph = await buildBootGraph(profileDir)
      expect(graph.entries.map((entry) => entry.id)).toEqual([plugin.id])
      // 样例是构建后安装的，加载的就是 dist 里的构建产物。
      expect(graph.entries[0]?.url).toContain("/pigcode-capability-clock/dist/client.js?rev=")
    } finally {
      await settleSocket(ctx)
      await ctx.fiber.dispose()
    }
  })
})

describe("built-in agents support MCP", () => {
  it("advertises mcp for Claude and Codex", () => {
    expect(new ClaudeDriver().features.mcp).toBe(true)
    expect(new CodexDriver().features.mcp).toBe(true)
  })
})

describe("agent MCP injection", () => {
  it("passes thread-scoped MCP handles into createSession", async () => {
    const { ctx, pluginId } = await installClockSample()
    let captured: CreateSessionInput | undefined
    const driver: AgentDriver = {
      id: "capture-mcp",
      displayName: "Capture MCP",
      features: new FakeAgentDriver().features,
      createSession: async (input) => {
        captured = input
        return {
          id: "ps_capture",
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: null,
          permissionMode: "workspace-write",
          model: null,
        }
      },
      send: async (_session, _input, runtime) => {
        runtime.emit({ type: "message.completed", text: "ok" })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    ctx.agents.register(driver)
    const project = ctx.projects.add(await mkdtemp(join(tmpdir(), "pigcode-clock-project-")))
    const thread = ctx.threads.create(project.id, "Clock", driver.id)
    try {
      const { done } = await ctx.agents.startRun(thread.id, "what time is it")
      await done

      expect(captured?.mcp?.tools.map((tool) => tool.name)).toContain("clock_now")
      const result = (await captured?.mcp?.callTool("clock_now", {})) as { now?: string }
      expect(typeof result.now).toBe("string")
      expect(captured?.mcp?.stdioServer()).toMatchObject({ command: process.execPath })
      // 样例插件 id 已随启用的 Capability 插件注册到 bridge。
      expect(pluginId).toBe("capability.pigcode-capability-clock")
    } finally {
      await settleSocket(ctx)
      await ctx.fiber.dispose()
    }
  })
})
