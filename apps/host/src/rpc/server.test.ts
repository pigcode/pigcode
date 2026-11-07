import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as agentsPlugin } from "../agents/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { GitNoRemoteError, GithubService } from "../services/github"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

async function createServer() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
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
        permissionMode: "read-only",
      }),
    ).toMatchObject({
      result: {
        defaultAgentId: "fake",
        lastAgentId: "fake",
        lastModelId: "fake-pro",
        permissionMode: "read-only",
      },
    })
    // 没选模型和权限时和以前一样：默认模型、每次询问。
    expect(
      await send("2", "thread.create", { projectId: project.id, title: "新会话", agentId: "fake" }),
    ).toMatchObject({
      result: { lastAgentId: null, lastModelId: null, permissionMode: "workspace-write" },
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
