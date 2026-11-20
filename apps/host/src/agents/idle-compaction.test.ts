import { Context } from "cordis"
import { expect, it, vi } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { FakeAgentDriver } from "./fake"
import { apply as agents } from "./registry"
import type { AgentDriver } from "./driver"

it("compacts the same idle Claude session once before expiry and rechecks newer turns, small contexts, changed settings and archives", async () => {
  vi.useFakeTimers()
  const ctx = new Context()
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents, { fake: false })
    const prompts: string[] = []
    const driver: AgentDriver = {
      id: "claude",
      displayName: "Claude",
      features: new FakeAgentDriver().features,
      createSession: async (input) => ({
        id: input.sessionId ?? "session_" + input.threadId,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: "n_" + input.threadId,
        permissionMode: "supervised",
        model: null,
      }),
      send: async (session, input, runtime) => {
        prompts.push(input.text)
        runtime.emit({ type: "session.started", nativeSessionId: session.nativeSessionId! })
        runtime.emit({
          type: "context.updated",
          usedTokens: input.text === "small" ? 100 : 250000,
          maxTokens: 1000000,
          autoCompactTokens: null,
          promptCacheExpiresAt: new Date(Date.now() + 300000).toISOString(),
        })
        if (input.text === "background")
          runtime.emit({ type: "subagent.started", toolCallId: "task", name: "worker" })
        runtime.emit({ type: "run.completed" })
      },
      dispose: async () => {},
      interrupt: async () => {},
    }
    ctx.agents.register(driver)
    ctx.settings.set("claude.idleCompaction", "beforeCacheExpires")
    const project = ctx.projects.add("/tmp")
    const thread = ctx.threads.create(project.id, "Idle", "claude")
    const run = async (text: string) => {
      await (
        await ctx.agents.startRun(thread.id, text)
      ).done
    }
    await run("first")
    await vi.advanceTimersByTimeAsync(60_000)
    await run("second")
    await vi.advanceTimersByTimeAsync(179_999)
    expect(prompts).toEqual(["first", "second"])
    await vi.advanceTimersByTimeAsync(1)
    expect(prompts).toEqual(["first", "second", "/compact"])
    await vi.advanceTimersByTimeAsync(301_000)
    expect(prompts.filter((p) => p === "/compact")).toHaveLength(1)
    await run("small")
    await vi.advanceTimersByTimeAsync(181_000)
    await run("background")
    await vi.advanceTimersByTimeAsync(181_000)
    await run("disabled")
    ctx.agents.updateSettings("claude", { idleCompaction: "off" })
    await vi.advanceTimersByTimeAsync(181_000)
    ctx.agents.updateSettings("claude", { idleCompaction: "beforeCacheExpires" })
    await run("archived")
    ctx.threads.archive(thread.id)
    await vi.advanceTimersByTimeAsync(181_000)
    expect(prompts.filter((p) => p === "/compact")).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
    vi.useRealTimers()
  }
})
