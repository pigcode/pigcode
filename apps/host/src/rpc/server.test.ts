import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as agentsPlugin } from "../agents/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { GitNoRemoteError, GithubService } from "../services/github"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

async function createServer() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const transport = new MemoryTransport()
  const server = new RpcServer(ctx, transport.host)
  server.start()
  return { ctx, transport, server }
}

describe("rpc server", () => {
  it("keeps the code of errors the UI explains and reports the rest as COMMAND_FAILED", async () => {
    const { ctx, transport } = await createServer()
    const github = new GithubService(
      async () => "",
      () => "/tmp",
      async () => "main",
    )
    github.status = async () => {
      throw new GitNoRemoteError("no git remotes found")
    }
    github.create = async () => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
    }
    ctx.provide("github", github)
    const send = async (id: string, method: string, params: unknown) => {
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      return transport.client.next()
    }

    expect(await send("1", "pr.status", { threadId: "t1" })).toMatchObject({
      error: { code: "GIT_NO_REMOTE", message: "no git remotes found" },
    })
    expect(await send("2", "pr.create", { threadId: "t1", title: "Title" })).toMatchObject({
      error: { code: "COMMAND_FAILED", message: "database is locked" },
    })
    await ctx.fiber.dispose()
  })

  it("answers project.list", async () => {
    const { ctx, transport } = await createServer()
    transport.client.send({ jsonrpc: "2.0", id: "1", method: "project.list", params: {} })
    const response = await transport.client.next()
    expect(response).toMatchObject({ jsonrpc: "2.0", id: "1", result: [] })
    await ctx.fiber.dispose()
  })

  it("archives a thread and keeps it archived", async () => {
    const { ctx, transport } = await createServer()
    const project = ctx.projects.add("/tmp/pigcode-archive")
    const thread = ctx.threads.create(project.id, "To archive", "fake")
    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "thread.archive",
      params: { threadId: thread.id },
    })
    const response = (await transport.client.next()) as { result: { archivedAt: string | null } }
    expect(response.result.archivedAt).toEqual(expect.any(String))
    const archivedAt = response.result.archivedAt
    // 再次归档不改变时间。
    transport.client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "thread.archive",
      params: { threadId: thread.id },
    })
    expect(await transport.client.next()).toMatchObject({ result: { archivedAt } })
    transport.client.send({
      jsonrpc: "2.0",
      id: "3",
      method: "thread.archive",
      params: { threadId: "missing" },
    })
    expect(await transport.client.next()).toMatchObject({ id: "3", error: expect.anything() })
    await ctx.fiber.dispose()
  })

  it("stops the thread's running agent when it is archived", async () => {
    const { ctx, transport } = await createServer()
    const project = ctx.projects.add("/tmp/pigcode-archive-running")
    const thread = ctx.threads.create(project.id, "Busy", "fake")
    const other = ctx.threads.create(project.id, "Also busy", "fake")
    const busy = await ctx.agents.startRun(thread.id, "long")
    const untouched = await ctx.agents.startRun(other.id, "long")

    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "thread.archive",
      params: { threadId: thread.id },
    })
    expect(await transport.client.next()).toMatchObject({ id: "1", result: { id: thread.id } })
    await busy.done
    expect(ctx.agents.getRunStatus(busy.runId)).toBe("interrupted")
    expect(ctx.agents.getRunStatus(untouched.runId)).toBe("running")
    await ctx.fiber.dispose()
  })

  it("renames and removes projects, stopping agents that run in a removed one", async () => {
    const { ctx, transport } = await createServer()
    const kept = ctx.projects.add("/tmp/pigcode-kept")
    const removed = ctx.projects.add("/tmp/pigcode-removed")
    const busy = await ctx.agents.startRun(
      ctx.threads.create(removed.id, "Busy", "fake").id,
      "long",
    )
    const other = await ctx.agents.startRun(ctx.threads.create(kept.id, "Other", "fake").id, "long")
    const send = async (id: string, method: string, params: unknown) => {
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      return transport.client.next()
    }

    expect(
      await send("1", "project.rename", { projectId: kept.id, name: "  新名字  " }),
    ).toMatchObject({
      result: { id: kept.id, name: "新名字" },
    })
    expect(await send("2", "project.rename", { projectId: kept.id, name: "   " })).toMatchObject({
      error: expect.anything(),
    })
    expect(await send("3", "project.remove", { projectId: removed.id })).toMatchObject({
      result: { id: removed.id },
    })
    await busy.done
    expect(ctx.agents.getRunStatus(busy.runId)).toBe("interrupted")
    expect(ctx.agents.getRunStatus(other.runId)).toBe("running")
    expect(await send("4", "project.list", {})).toMatchObject({ result: [{ id: kept.id }] })
    expect(await send("5", "project.remove", { projectId: "missing" })).toMatchObject({
      error: expect.anything(),
    })
    await ctx.fiber.dispose()
  })

  it("creates a thread with the model and permission picked in the new thread draft", async () => {
    const { ctx, transport } = await createServer()
    const project = ctx.projects.add("/tmp/pigcode-draft")
    const send = async (id: string, method: string, params: unknown) => {
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      return transport.client.next()
    }

    expect(
      await send("1", "thread.create", {
        projectId: project.id,
        title: "新会话",
        agentId: "fake",
        modelId: "fake-pro",
        permissionMode: "approval-required",
      }),
    ).toMatchObject({
      result: {
        defaultAgentId: "fake",
        lastAgentId: "fake",
        lastModelId: "fake-pro",
        permissionMode: "approval-required",
      },
    })
    // 没选模型和权限时和以前一样：默认模型、每次询问。
    expect(
      await send("2", "thread.create", { projectId: project.id, title: "新会话", agentId: "fake" }),
    ).toMatchObject({
      result: { lastAgentId: null, lastModelId: null, permissionMode: "full-access" },
    })
    await ctx.fiber.dispose()
  })

  it("validates the ID and initial settings before saving a configured instance", async () => {
    const { ctx, transport } = await createServer()
    const draft = { agentId: "fake", label: "公司 API", instanceId: "fake_work" }
    let requestId = 0
    const create = (params: Record<string, unknown>) => {
      transport.client.send({
        jsonrpc: "2.0",
        id: String(++requestId),
        method: "agent.createInstance",
        params,
      })
      return transport.client.next()
    }
    try {
      ctx.agents.updateSettings("fake", { customModels: ["default-model"] })
      expect(await create({ ...draft, values: { unknownSetting: "value" } })).toMatchObject({
        error: expect.anything(),
      })
      expect(ctx.agents.findInstance(draft.instanceId)).toBeNull()

      for (const instanceId of ["fake", "constructor"]) {
        expect(await create({ ...draft, instanceId, values: {} })).toMatchObject({
          error: { code: "AGENT_INSTANCE_ID_TAKEN" },
        })
      }
      expect(await create({ ...draft, instanceId: "work api", values: {} })).toMatchObject({
        error: expect.anything(),
      })

      const values = { customModels: ["work-model"] }
      expect(
        await create({ ...draft, values: { customModels: [" work-model ", "work-model"] } }),
      ).toMatchObject({ result: { ...draft, values } })
      expect(await create({ ...draft, label: "重复实例", values: {} })).toMatchObject({
        error: { code: "AGENT_INSTANCE_ID_TAKEN" },
      })
      expect(ctx.agents.findInstance(draft.instanceId)).toMatchObject({ ...draft, values })
      expect(ctx.agents.getSettings("fake")).toEqual({ customModels: ["default-model"] })

      expect(
        await create({ agentId: "fake", label: "旧版客户端", copyFrom: draft.instanceId }),
      ).toMatchObject({ result: { instanceId: expect.stringMatching(/^inst_/), values } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("creates, edits, defaults and removes agent instances over RPC", async () => {
    const { ctx, transport } = await createServer()
    const send = async (id: string, method: string, params: unknown) => {
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      return transport.client.next()
    }

    const created = (await send("1", "agent.createInstance", {
      agentId: "fake",
      label: "  公司 API  ",
    })) as { result: { instanceId: string; label: string; isDefault: boolean } }
    expect(created.result).toMatchObject({ label: "公司 API", isDefault: false })
    const instanceId = created.result.instanceId

    // 列表里这个 agent 有两个实例，默认实例在最前。
    const list = (await send("2", "agent.list", {})) as {
      result: { agents: Array<{ agentId: string; instances: Array<{ instanceId: string }> }> }
    }
    const fake = list.result.agents.find((agent) => agent.agentId === "fake")
    expect(fake?.instances.map((instance) => instance.instanceId)).toEqual(["fake", instanceId])

    // 设置写进指定实例，默认实例不受影响。
    await send("3", "agent.updateSettings", {
      agentId: "fake",
      instanceId,
      values: { customModels: ["fake-work"] },
    })
    expect(ctx.agents.getSettings("fake", instanceId)).toEqual({ customModels: ["fake-work"] })
    expect(ctx.agents.getSettings("fake")).toEqual({})

    // 只给实例也能读模型目录：Host 自己找到它属于哪个 Agent。
    const models = (await send("3b", "agent.models", { instanceId })) as {
      result: Array<{ id: string; custom?: boolean }>
    }
    expect(models.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fake-work", custom: true })]),
    )

    // 设为默认后，新会话用它。
    await send("4", "agent.setDefault", { agentId: "fake", instanceId })
    expect(await send("5", "agent.default", {})).toMatchObject({
      result: { id: "fake", instanceId },
    })

    // 默认实例不能改、不能删。
    expect(
      await send("6", "agent.updateInstance", { instanceId: "fake", patch: { enabled: false } }),
    ).toMatchObject({ error: expect.anything() })
    expect(await send("7", "agent.removeInstance", { instanceId: "fake" })).toMatchObject({
      error: expect.anything(),
    })

    // 删掉选中的实例后，默认回到这个 agent 的默认实例。
    await send("8", "agent.removeInstance", { instanceId })
    expect(await send("9", "agent.default", {})).toMatchObject({
      result: { id: "fake", instanceId: "fake" },
    })
    await ctx.fiber.dispose()
  })

  it("adds a project with the given name, or the folder name when none is given", async () => {
    const { ctx, transport } = await createServer()
    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "project.add",
      params: { rootPath: "/tmp/pigcode-named", name: "  客户门户  " },
    })
    expect(await transport.client.next()).toMatchObject({
      id: "1",
      result: { rootPath: "/tmp/pigcode-named", name: "客户门户" },
    })
    transport.client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "project.add",
      params: { rootPath: "/tmp/pigcode-plain/" },
    })
    expect(await transport.client.next()).toMatchObject({
      id: "2",
      result: { name: "pigcode-plain" },
    })
    await ctx.fiber.dispose()
  })
})
