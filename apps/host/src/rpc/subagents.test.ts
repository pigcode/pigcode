/** 验证子代理会话：挂在主会话下、带主会话近况、共用工作目录、随主会话归档。 */
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import type { ProviderDriver, UserInput } from "../providers/driver"
import { apply as providers } from "../providers/registry"
import { threadCwd } from "../services/worktrees"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

/** 记录输入与 cwd；`hold` 输入一直运行到被取消。 */
function recordingDriver() {
  const inputs: Array<{ threadId: string; cwd: string; input: UserInput }> = []
  const driver: ProviderDriver = {
    id: "rec",
    displayName: "Recorder",
    capabilities: {
      streaming: true,
      approvals: false,
      questions: false,
      plan: false,
      resume: false,
      fork: false,
      rollback: false,
      checkpoint: false,
      subagents: false,
      mcp: false,
      images: false,
      usage: false,
      modelCatalog: false,
      nativeSessionId: false,
    },
    async createSession(input) {
      return {
        id: `rec_${input.threadId}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(session, input, runtime) {
      inputs.push({ threadId: session.threadId, cwd: session.cwd, input })
      if (input.text === "hold") {
        await new Promise<void>((resolve) => {
          if (runtime.signal.aborted) resolve()
          runtime.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return
      }
      runtime.emit({ type: "message.completed", text: `done: ${input.text}` })
      runtime.emit({ type: "run.completed" })
    },
    async interrupt() {},
    async dispose() {},
  }
  return { driver, inputs }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const recorder = recordingDriver()
  ctx.providers.register(recorder.driver)
  const transport = new MemoryTransport()
  new RpcServer(ctx, transport.host).start()
  const project = ctx.projects.add("/tmp/pigcode-subagents")
  let id = 0
  const call = async (method: string, params: unknown) => {
    id += 1
    transport.client.send({ jsonrpc: "2.0", id: String(id), method, params })
    for (;;) {
      const message = (await transport.client.next()) as {
        id?: string
        result?: unknown
        error?: { message: string }
      }
      if (message.id !== String(id)) continue
      if (message.error) throw new Error(message.error.message)
      return message.result
    }
  }
  return { ctx, project, call, recorder }
}

describe("sub-agent threads", () => {
  it("creates a sub-agent that starts with a brief of the main thread", async () => {
    const { ctx, project, call, recorder } = await setup()
    const main = ctx.threads.create(project.id, "修登录", "rec")
    await call("run.start", { threadId: main.id, text: "检查登录流程" })
    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(0))

    const child = (await call("thread.create", {
      projectId: project.id,
      title: "Codex 子代理",
      providerId: "rec",
      parentThreadId: main.id,
    })) as { id: string; parentThreadId: string | null }
    expect(child.parentThreadId).toBe(main.id)
    expect(ctx.threads.children(main.id).map((thread) => thread.id)).toEqual([child.id])
    expect(ctx.sessions.read(child.id, 0)[0]).toMatchObject({
      type: "thread.created",
      payload: { title: "Codex 子代理", parentThreadId: main.id },
    })

    await call("run.start", { threadId: child.id, text: "写测试" })
    await vi.waitFor(() => expect(recorder.inputs).toHaveLength(2))
    const brief = recorder.inputs[1]?.input.handoff ?? ""
    expect(brief).toContain("sub-agent working next to the main agent (rec)")
    expect(brief).toContain('"修登录"')
    expect(brief).toContain("- user: 检查登录流程")
    expect(brief).toContain("- assistant: done: 检查登录流程")

    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(0))
    await call("run.start", { threadId: child.id, text: "继续" })
    await vi.waitFor(() => expect(recorder.inputs).toHaveLength(3))
    expect(recorder.inputs[2]?.input).toEqual({ text: "继续" })
    await ctx.fiber.dispose()
  })

  it("skips the brief while the main thread has no conversation", async () => {
    const { ctx, project, call, recorder } = await setup()
    const main = ctx.threads.create(project.id, "空会话", "rec")
    const child = (await call("thread.create", {
      projectId: project.id,
      title: "子代理",
      providerId: "rec",
      parentThreadId: main.id,
    })) as { id: string }
    await call("run.start", { threadId: child.id, text: "hi" })
    await vi.waitFor(() => expect(recorder.inputs).toHaveLength(1))
    expect(recorder.inputs[0]?.input).toEqual({ text: "hi" })
    await ctx.fiber.dispose()
  })

  it("rejects sub-agents of unknown, foreign or nested parents", async () => {
    const { ctx, project, call } = await setup()
    const other = ctx.projects.add("/tmp/pigcode-subagents-other")
    const main = ctx.threads.create(project.id, "主会话", "rec")
    const child = ctx.threads.create(project.id, "子代理", "rec", main.id)
    const create = (projectId: string, parentThreadId: string) =>
      call("thread.create", { projectId, title: "x", providerId: "rec", parentThreadId })

    await expect(create(project.id, "th_missing")).rejects.toThrow("thread not found")
    await expect(create(other.id, main.id)).rejects.toThrow("THREAD_PARENT_PROJECT_MISMATCH")
    await expect(create(project.id, child.id)).rejects.toThrow("THREAD_PARENT_IS_SUBAGENT")
    await ctx.fiber.dispose()
  })

  it("archives sub-agents with the main thread and stops their runs", async () => {
    const { ctx, project, call } = await setup()
    const main = ctx.threads.create(project.id, "主会话", "rec")
    const child = ctx.threads.create(project.id, "子代理", "rec", main.id)
    await call("run.start", { threadId: child.id, text: "hold" })
    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(1))

    await call("thread.archive", { threadId: main.id })

    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(0))
    expect(ctx.threads.get(child.id)?.archivedAt).not.toBeNull()
    expect(ctx.threads.children(main.id)).toEqual([])
    await ctx.fiber.dispose()
  })

  it("runs a sub-agent in the main thread's worktree", async () => {
    const { ctx, project } = await setup()
    const main = ctx.threads.create(project.id, "主会话", "rec")
    const child = ctx.threads.create(project.id, "子代理", "rec", main.id)
    expect(threadCwd(ctx, child.id)).toBe(project.rootPath)
    ctx.storage.db
      .prepare(
        `INSERT INTO worktrees (id, project_id, thread_id, path, branch, status, created_at)
         VALUES ('wt_1', ?, ?, '/tmp/pigcode-subagents-wt', 'pigcode/main', 'active', ?)`,
      )
      .run(project.id, main.id, new Date().toISOString())
    expect(threadCwd(ctx, child.id)).toBe("/tmp/pigcode-subagents-wt")
    await ctx.fiber.dispose()
  })
})
