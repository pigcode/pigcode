/** 验证 startRun 写入 user/run 事件、驱动 fake provider 并完成 run。 */
import { Context } from "cordis"
import type { ProviderDriver } from "./driver"
import { describe, expect, it } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { FakeProviderDriver } from "./fake"
import { apply as providers } from "./registry"

async function setup(providerId = "fake") {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
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
function blockingDriver(): { driver: ProviderDriver; release: () => void } {
  let release: () => void = () => undefined
  const driver: ProviderDriver = {
    id: "blocking",
    displayName: "Blocking",
    capabilities: new FakeProviderDriver().capabilities,
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

describe("providers.startRun", () => {
  it("persists the user message and completes the run", async () => {
    const { ctx, thread } = await setup()
    const { runId, done } = await ctx.providers.startRun(thread.id, "hello")
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
    expect(ctx.providers.getRunStatus(runId)).toBe("completed")
    await ctx.fiber.dispose()
  })

  it("rejects a second run while the thread has an active run", async () => {
    const { ctx, thread } = await setup("blocking")
    const blocking = blockingDriver()
    ctx.providers.register(blocking.driver)

    const first = await ctx.providers.startRun(thread.id, "one")
    await expect(ctx.providers.startRun(thread.id, "two")).rejects.toThrow("RUN_ALREADY_ACTIVE")
    blocking.release()
    await first.done
    expect(ctx.providers.getRunStatus(first.runId)).toBe("completed")
    await ctx.fiber.dispose()
  })

  it("persists approval requests and resumes the run after a decision", async () => {
    const { ctx, thread } = await setup("approval")
    let decisionSeen: string | undefined
    const driver: ProviderDriver = {
      id: "approval",
      displayName: "Approval",
      capabilities: new FakeProviderDriver().capabilities,
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
    ctx.providers.register(driver)

    const { runId, done } = await ctx.providers.startRun(thread.id, "approve")
    await waitFor(() =>
      ctx.sessions.read(thread.id, 0).some((event) => event.type === "approval.requested"),
    )
    const requested = ctx.sessions
      .read(thread.id, 0)
      .find((event) => event.type === "approval.requested")
    const requestId = (requested?.payload as { requestId?: string }).requestId
    if (!requestId) throw new Error("approval request id missing")
    expect(ctx.providers.getRunStatus(runId)).toBe("waiting-approval")
    ctx.providers.respondApproval(thread.id, runId, requestId, "allow-once")
    await done

    expect(decisionSeen).toBe("allow-once")
    const events = ctx.sessions.read(thread.id, 0)
    expect(events.some((event) => event.type === "approval.resolved")).toBe(true)
    expect(ctx.providers.getRunStatus(runId)).toBe("completed")
    const pending = ctx.storage.db
      .prepare(`SELECT status FROM pending_requests WHERE id = ?`)
      .get(requestId) as { status: string }
    expect(pending.status).toBe("resolved")
    await ctx.fiber.dispose()
  })
})
