/** 验证 startRun 写入 user/run 事件、驱动 fake agent 并完成 run。 */
import { Context } from "cordis"
import type { AgentDriver } from "./driver"
import { describe, expect, it } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"

async function setup(providerId = "fake") {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const project = ctx.projects.add("/tmp/pigcode-m1")
  const thread = ctx.threads.create(project.id, "M1", providerId)
  return { ctx, thread }
}

/** 轮询到条件成立，最多等待约 100ms；避免依赖固定 sleep。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition not met")
}

/** 构造一个阻塞到测试显式放行的 driver，用来验证并发 run 限制。 */
function blockingDriver(): { driver: AgentDriver; release: () => void } {
  let release: () => void = () => undefined
  const driver: AgentDriver = {
    id: "blocking",
    displayName: "Blocking",
    features: new FakeAgentDriver().features,
    createSession: async (input) => ({
      id: "ps_blocking",
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: null,
      permissionMode: "workspace-write",
      model: null,
    }),
    send: async (_session, _input, runtime) => {
      runtime.emit({ type: "run.started" })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return { driver, release: () => release() }
}

describe("agents.startRun", () => {
  it("persists the user message and completes the run", async () => {
    const { ctx, thread } = await setup()
    const { runId, done } = await ctx.agents.startRun(thread.id, "hello")
    await done
    const events = ctx.sessions.read(thread.id, 0)
    expect(
      events.some(
        (event) =>
          event.type === "message.completed" &&
          (event.payload as { role?: string } | null)?.role === "user",
      ),
    ).toBe(true)
    expect(events.some((event) => event.type === "run.completed")).toBe(true)
    expect(ctx.agents.getRunStatus(runId)).toBe("completed")
    await ctx.fiber.dispose()
  })

  it("persists subagent events and parent attribution", async () => {
    const { ctx, thread } = await setup("subagents")
    const driver: AgentDriver = {
      id: "subagents",
      displayName: "Subagents",
      features: new FakeAgentDriver().features,
      createSession: async (input) => ({
        id: "ps_subagents",
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }),
      send: async (_session, _input, runtime) => {
        runtime.emit({
          type: "subagent.started",
          toolCallId: "task_1",
          name: "Explore",
          description: "Find the entry point",
          model: "haiku",
        })
        runtime.emit({
          type: "message.completed",
          text: "child reply",
          parentToolUseId: "task_1",
        })
        runtime.emit({
          type: "tool.started",
          toolCallId: "read_1",
          name: "Read",
          input: { file_path: "a.ts" },
          parentToolUseId: "task_1",
        })
        runtime.emit({
          type: "tool.completed",
          toolCallId: "read_1",
          name: "Read",
          output: "body",
          isError: false,
          parentToolUseId: "task_1",
        })
        runtime.emit({
          type: "subagent.completed",
          toolCallId: "task_1",
          output: "report",
          isError: false,
          status: "completed",
        })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    ctx.agents.register(driver)

    const { done } = await ctx.agents.startRun(thread.id, "spawn a subagent")
    await done
    const events = ctx.sessions.read(thread.id, 0)

    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1)
    expect(events.find((event) => event.type === "subagent.started")?.payload).toMatchObject({
      toolCallId: "task_1",
      name: "Explore",
      description: "Find the entry point",
      model: "haiku",
    })
    expect(
      events.find(
        (event) =>
          event.type === "message.completed" &&
          (event.payload as { parentToolUseId?: string } | null)?.parentToolUseId === "task_1",
      )?.payload,
    ).toMatchObject({ text: "child reply", parentToolUseId: "task_1" })
    expect(events.find((event) => event.type === "subagent.completed")?.payload).toMatchObject({
      toolCallId: "task_1",
      output: "report",
      isError: false,
      status: "completed",
    })
    await ctx.fiber.dispose()
  })

  it("rejects a second run while the thread has an active run", async () => {
    const { ctx, thread } = await setup("blocking")
    const blocking = blockingDriver()
    ctx.agents.register(blocking.driver)

    const first = await ctx.agents.startRun(thread.id, "one")
    await expect(ctx.agents.startRun(thread.id, "two")).rejects.toThrow("RUN_ALREADY_ACTIVE")
    blocking.release()
    await first.done
    expect(ctx.agents.getRunStatus(first.runId)).toBe("completed")
    await ctx.fiber.dispose()
  })

  it("persists approval requests and resumes the run after a decision", async () => {
    const { ctx, thread } = await setup("approval")
    let decisionSeen: string | undefined
    const driver: AgentDriver = {
      id: "approval",
      displayName: "Approval",
      features: new FakeAgentDriver().features,
      createSession: async (input) => ({
        id: "ps_approval",
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }),
      send: async (_session, _input, runtime) => {
        decisionSeen = await runtime.requestApproval({
          toolName: "Bash",
          input: { command: "echo hi" },
        })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    ctx.agents.register(driver)

    const { runId, done } = await ctx.agents.startRun(thread.id, "approve")
    await waitFor(() =>
      ctx.sessions.read(thread.id, 0).some((event) => event.type === "approval.requested"),
    )
    const requested = ctx.sessions
      .read(thread.id, 0)
      .find((event) => event.type === "approval.requested")
    const requestId = (requested?.payload as { requestId?: string }).requestId
    if (!requestId) throw new Error("approval request id missing")
    expect(ctx.agents.getRunStatus(runId)).toBe("waiting-approval")
    ctx.agents.respondApproval(thread.id, runId, requestId, "allow-once")
    await done

    expect(decisionSeen).toBe("allow-once")
    const events = ctx.sessions.read(thread.id, 0)
    expect(events.some((event) => event.type === "approval.resolved")).toBe(true)
    expect(ctx.agents.getRunStatus(runId)).toBe("completed")
    const pending = ctx.storage.db
      .prepare(`SELECT status FROM pending_requests WHERE id = ?`)
      .get(requestId) as { status: string }
    expect(pending.status).toBe("resolved")
    await ctx.fiber.dispose()
  })

  it("honors the forced agent env only for registered agents", async () => {
    process.env.PIGCODE_AGENT = "claude"
    const { ctx } = await setup()
    try {
      // Claude Code 由插件注册；插件没加载时强制指定不生效，回到 fake。
      await expect(ctx.agents.defaultAgent()).resolves.toBe("fake")
      ctx.agents.register({ ...blockingDriver().driver, id: "claude", displayName: "Claude" })
      await expect(ctx.agents.defaultAgent()).resolves.toBe("claude")
    } finally {
      delete process.env.PIGCODE_AGENT
      await ctx.fiber.dispose()
    }
  })

  it("honors a forced agent registered by a plugin", async () => {
    const { ctx } = await setup()
    ctx.agents.register({
      id: "echo",
      displayName: "Echo",
      features: new FakeAgentDriver().features,
      createSession: async (input) => ({
        id: "ps_echo",
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }),
      send: async () => undefined,
      interrupt: async () => undefined,
      dispose: async () => undefined,
    })
    process.env.PIGCODE_AGENT = "echo"
    try {
      await expect(ctx.agents.defaultAgent()).resolves.toBe("echo")
    } finally {
      delete process.env.PIGCODE_AGENT
      await ctx.fiber.dispose()
    }
  })

  it("persists plan updates and interrupted runs", async () => {
    const { ctx, thread } = await setup()
    ctx.agents.register({
      id: "test",
      displayName: "Test",
      features: new FakeAgentDriver().features,
      createSession: async (input) => ({
        id: "ps_test",
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }),
      send: async (_session, _input, runtime) => {
        runtime.emit({ type: "plan.updated", plan: { steps: [] }, explanation: null })
        runtime.emit({ type: "run.interrupted" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    })
    const testThread = ctx.threads.create(thread.projectId, "Plan", "test")
    const { runId, done } = await ctx.agents.startRun(testThread.id, "plan")
    await done

    const events = ctx.sessions.read(testThread.id, 0)
    expect(events.some((event) => event.type === "plan.updated")).toBe(true)
    expect(events.some((event) => event.type === "run.interrupted")).toBe(true)
    expect(ctx.agents.getRunStatus(runId)).toBe("interrupted")
    await ctx.fiber.dispose()
  })
})
