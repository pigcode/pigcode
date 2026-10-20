/** 验证 run.respondApproval RPC 决议审批并持久化结果。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as providers } from "../providers/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

/** 建立内存 Host，并插入一条外部来源的 run 行。 */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const project = ctx.projects.add("/tmp/pigcode-m1")
  const thread = ctx.threads.create(project.id, "M1", "fake")
  ctx.storage.db
    .prepare(
      `INSERT INTO runs (id, thread_id, provider_session_id, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run("run-1", thread.id, "ps-1", new Date().toISOString())
  const transport = new MemoryTransport()
  const server = new RpcServer(ctx, transport.host)
  server.start()
  return { ctx, thread, transport, server }
}

describe("approval rpc", () => {
  it("resolves a pending approval through run.respondApproval", async () => {
    const { ctx, thread, transport, server } = await setup()
    const pending = ctx.providers.requestApproval(thread.id, "run-1", {
      toolName: "Bash",
      input: { command: "echo hi" },
      title: "Run a command?",
    })

    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "run.respondApproval",
      params: {
        threadId: thread.id,
        runId: "run-1",
        requestId: pending.requestId,
        decision: "allow-once",
      },
    })
    const response = await transport.client.next()
    expect(response).toMatchObject({ jsonrpc: "2.0", id: "1", result: { ok: true } })
    await expect(pending.decision).resolves.toBe("allow-once")

    const row = ctx.storage.db
      .prepare(`SELECT status FROM pending_requests WHERE id = ?`)
      .get(pending.requestId) as { status: string }
    expect(row.status).toBe("resolved")
    expect(ctx.providers.getRunStatus("run-1")).toBe("running")
    const resolved = ctx.sessions
      .read(thread.id, 0)
      .find((event) => event.type === "approval.resolved")
    expect(resolved?.payload).toMatchObject({
      requestId: pending.requestId,
      decision: "allow-once",
    })
    server.stop()
    await ctx.fiber.dispose()
  })

  it("rejects an approval that is no longer pending", async () => {
    const { ctx, thread, transport, server } = await setup()
    const pending = ctx.providers.requestApproval(thread.id, "run-1", {
      toolName: "Bash",
      input: { command: "echo hi" },
    })
    ctx.providers.respondApproval(thread.id, "run-1", pending.requestId, "deny")
    await pending.decision

    transport.client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "run.respondApproval",
      params: {
        threadId: thread.id,
        runId: "run-1",
        requestId: pending.requestId,
        decision: "allow-once",
      },
    })
    const response = (await transport.client.next()) as {
      error: { code: string; message: string }
    }
    expect(response.error.code).toBe("COMMAND_FAILED")
    expect(response.error.message).toContain("not pending")
    server.stop()
    await ctx.fiber.dispose()
  })
})
