/** 验证第三方 Agent 插件样例：从仓库 examples 安装、热启用并完成一次 run。 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Thread } from "@pigcode/contracts"
import { installLocalPlugin } from "./plugin-installer"
import { setupHost } from "./plugin-harness"
import { apply as settings } from "./settings"

/** 仓库内的 echo 样例目录；测试按安装路径复制，走真实的本地安装流程。 */
const ECHO_SOURCE = fileURLToPath(new URL("../../../../examples/agent-echo", import.meta.url))

/** 安装并启用 echo 样例，返回可发起 run 的线程。 */
async function installEchoAgent(): Promise<{ ctx: Context; thread: Thread }> {
  const { ctx, profileDir } = await setupHost({ prefix: "pigcode-echo-", extra: [settings] })
  const plugin = await installLocalPlugin(profileDir, ECHO_SOURCE)
  await ctx.plugins.enable(plugin.id)
  await ctx.loader.await()
  const project = ctx.projects.add(await mkdtemp(join(tmpdir(), "pigcode-echo-project-")))
  const thread = ctx.threads.create(project.id, "Echo", "echo")
  return { ctx, thread }
}

/** 线程里 assistant 的完整回复，按时间顺序。 */
function assistantReplies(ctx: Context, threadId: string): Array<string | undefined> {
  return ctx.sessions
    .read(threadId, 0)
    .filter((event) => event.type === "message.completed")
    .map((event) => event.payload as { role?: string; text?: string })
    .filter((payload) => payload.role === "assistant")
    .map((payload) => payload.text)
}

describe("echo agent plugin", () => {
  it("loads the echo agent plugin and completes a run", async () => {
    const { ctx, thread } = await installEchoAgent()
    try {
      const { done } = await ctx.agents.startRun(thread.id, "hello")
      await done
      const events = ctx.sessions.read(thread.id, 0)
      expect(events.some((event) => event.type === "message.completed")).toBe(true)
      // 样例把用户输入原样回显；确认 assistant 消息确实来自 echo，而不是用户消息回执。
      expect(
        events.some((event) => {
          if (event.type !== "message.completed") return false
          const payload = event.payload as { role?: unknown; text?: unknown }
          return payload.role === "assistant" && payload.text === "hello"
        }),
      ).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("passes the agent's saved settings to the plugin driver", async () => {
    const { ctx, thread } = await installEchoAgent()
    try {
      ctx.agents.updateSettings("echo", { prefix: "echo:", uppercase: true })
      const { done } = await ctx.agents.startRun(thread.id, "hello")
      await done
      expect(assistantReplies(ctx, thread.id).at(-1)).toBe("echo: HELLO")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("starts a new session when the thread switches away and back", async () => {
    const { ctx, thread } = await installEchoAgent()
    try {
      await (
        await ctx.agents.startRun(thread.id, "one")
      ).done
      await ctx.agents.switchAgent(thread.id, "fake")
      await ctx.agents.switchAgent(thread.id, "echo")
      await (
        await ctx.agents.startRun(thread.id, "two")
      ).done
      const failures = ctx.sessions
        .read(thread.id, 0)
        .filter((event) => event.type === "run.failed")
      expect(failures.map((event) => event.payload)).toEqual([])
      expect(assistantReplies(ctx, thread.id).at(-1)).toBe("two")
      const echoSessions = ctx.agents
        .listSessions(thread.id)
        .filter((session) => session.agentId === "echo")
      expect(new Set(echoSessions.map((session) => session.id)).size).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
