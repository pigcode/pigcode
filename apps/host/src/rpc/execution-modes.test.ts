import { Context } from "cordis"
import { expect, it } from "vitest"
import type { AgentExecutionModes, Thread } from "@pigcode/contracts"
import type { AgentDriver } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { apply as agentsPlugin } from "../agents/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

function plugin(id: string, plan = true) {
  const received: Array<{ permission: string; plan: boolean }> = []
  const modes: AgentExecutionModes = { plan }
  const driver: AgentDriver = {
    id,
    displayName: id,
    features: new FakeAgentDriver().features,
    executionModes: modes,
    async createSession(input) {
      return {
        id: `${id}-${input.threadId}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: input.permissionMode ?? "full-access",
        planMode: input.planMode ?? false,
        model: null,
      }
    },
    async send(session, input, runtime) {
      received.push({ permission: session.permissionMode, plan: session.planMode === true })
      if (input.text === "exit-native-plan") runtime.setPlanMode?.(false)
    },
    async interrupt() {},
    async dispose() {},
  }
  return { driver, modes, received }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const wire = new MemoryTransport()
  new RpcServer(ctx, wire.host).start()
  const project = ctx.projects.add("/tmp/pigcode-mode-test")
  let id = 0
  async function call(method: string, params: unknown) {
    const key = String(++id)
    wire.client.send({ jsonrpc: "2.0", id: key, method, params })
    for (;;) {
      const result = (await wire.client.next()) as {
        id?: string
        result?: unknown
        error?: { message: string }
      }
      if (result.id !== key) continue
      if (result.error) throw new Error(result.error.message)
      return result.result
    }
  }
  return { ctx, project, call }
}

it("uses the platform default and keeps one permission and plan selection across agents", async () => {
  const { ctx, project, call } = await setup()
  try {
    const first = plugin("first")
    const second = plugin("second")
    ctx.agents.register(first.driver)
    ctx.agents.register(second.driver)
    const thread = (await call("thread.create", {
      projectId: project.id,
      agentId: "first",
    })) as Thread
    expect(thread).toMatchObject({ permissionMode: "full-access", planMode: false })
    await call("thread.setPlanMode", { threadId: thread.id, planMode: true })
    await call("thread.setPermissionMode", {
      threadId: thread.id,
      permissionMode: "auto-accept-edits",
    })
    await (
      await ctx.agents.startRun(thread.id, "plan")
    ).done
    expect(first.received).toEqual([{ permission: "auto-accept-edits", plan: true }])
    const child = (await call("thread.create", {
      projectId: project.id,
      agentId: "second",
      parentThreadId: thread.id,
    })) as Thread
    expect(child).toMatchObject({ permissionMode: "auto-accept-edits", planMode: true })
    await call("thread.switchAgent", { threadId: thread.id, agentId: "second" })
    expect(ctx.threads.get(thread.id)).toMatchObject({
      permissionMode: "auto-accept-edits",
      planMode: true,
    })
    await call("thread.setPlanMode", { threadId: thread.id, planMode: false })
    await call("thread.switchAgent", { threadId: thread.id, agentId: "first" })
    expect(ctx.threads.get(thread.id)).toMatchObject({
      permissionMode: "auto-accept-edits",
      planMode: false,
    })
    await call("thread.setPlanMode", { threadId: thread.id, planMode: true })
    await (
      await ctx.agents.startRun(thread.id, "exit-native-plan")
    ).done
    expect(ctx.threads.get(thread.id)).toMatchObject({
      permissionMode: "auto-accept-edits",
      planMode: false,
    })
  } finally {
    await ctx.fiber.dispose()
  }
})

it("rejects invalid platform modes and unsupported planning before starting a run", async () => {
  const { ctx, project, call } = await setup()
  try {
    ctx.agents.register(plugin("no-plan", false).driver)
    await expect(
      call("thread.create", {
        projectId: project.id,
        agentId: "no-plan",
        permissionMode: "invented",
      }),
    ).rejects.toThrow("Unsupported runtime permission")
    expect(ctx.threads.list()).toHaveLength(0)
    const thread = (await call("thread.create", {
      projectId: project.id,
      agentId: "no-plan",
    })) as Thread
    await expect(
      call("thread.setPermissionMode", {
        threadId: thread.id,
        permissionMode: "invented",
      }),
    ).rejects.toThrow("Unsupported runtime permission")
    await expect(
      call("thread.setPlanMode", { threadId: thread.id, planMode: true }),
    ).rejects.toThrow("does not support plan")
    ctx.threads.setPermissionMode(thread.id, "unavailable")
    await expect(ctx.agents.startRun(thread.id, "go")).rejects.toThrow(
      "Unsupported runtime permission",
    )
    expect(ctx.agents.listRuns()).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})
