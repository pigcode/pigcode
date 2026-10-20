/** 验证审批请求持久化、RPC 决议与 resolver 完成。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as providers } from "../registry"
import { apply as projects } from "../../services/projects"
import { apply as sessions } from "../../services/sessions"
import { apply as storage } from "../../services/storage"
import { apply as threads } from "../../services/threads"

describe("approval bridge", () => {
  it("resolves a pending approval", async () => {
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
    const pending = ctx.providers.requestApproval(thread.id, "run-1", {
      toolName: "Bash",
      input: { command: "echo hi" },
    })
    ctx.providers.respondApproval(thread.id, "run-1", pending.requestId, "allow-once")
    await expect(pending.decision).resolves.toBe("allow-once")
    await ctx.fiber.dispose()
  })

  it("persists the request, events and waiting-approval status", async () => {
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

    const pending = ctx.providers.requestApproval(thread.id, "run-1", {
      toolName: "Bash",
      input: { command: "echo hi" },
      title: "Run a command?",
      description: "echo hi",
      blockedPath: "/tmp",
      suggestions: [{ type: "addRules" }],
    })
    const row = ctx.storage.db
      .prepare(`SELECT status FROM pending_requests WHERE id = ?`)
      .get(pending.requestId) as { status: string }
    expect(row.status).toBe("pending")
    expect(ctx.providers.getRunStatus("run-1")).toBe("waiting-approval")
    const requested = ctx.sessions
      .read(thread.id, 0)
      .find((event) => event.type === "approval.requested")
    expect(requested?.payload).toMatchObject({
      requestId: pending.requestId,
      id: pending.requestId,
      toolName: "Bash",
      input: { command: "echo hi" },
      title: "Run a command?",
      description: "echo hi",
      blockedPath: "/tmp",
      suggestions: [{ type: "addRules" }],
    })

    ctx.providers.respondApproval(thread.id, "run-1", pending.requestId, "deny")
    await expect(pending.decision).resolves.toBe("deny")
    const resolved = ctx.storage.db
      .prepare(`SELECT status, resolved_at FROM pending_requests WHERE id = ?`)
      .get(pending.requestId) as { status: string; resolved_at: string | null }
    expect(resolved.status).toBe("resolved")
    expect(resolved.resolved_at).not.toBeNull()
    expect(ctx.providers.getRunStatus("run-1")).toBe("running")
    const resolvedEvent = ctx.sessions
      .read(thread.id, 0)
      .find((event) => event.type === "approval.resolved")
    expect(resolvedEvent?.payload).toMatchObject({
      requestId: pending.requestId,
      decision: "deny",
    })
    await ctx.fiber.dispose()
  })

  it("marks leftover pending requests orphaned when the registry starts", async () => {
    const ctx = new Context()
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    const project = ctx.projects.add("/tmp/pigcode-m1")
    const thread = ctx.threads.create(project.id, "M1", "fake")
    const now = new Date().toISOString()
    ctx.storage.db
      .prepare(
        `INSERT INTO runs (id, thread_id, provider_session_id, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run("run-old", thread.id, "ps-old", now)
    ctx.storage.db
      .prepare(
        `INSERT INTO pending_requests
         (id, thread_id, run_id, kind, provider_request_id, payload_json, status, created_at, resolved_at)
         VALUES (?, ?, ?, 'approval', NULL, '{}', 'pending', ?, NULL)`,
      )
      .run("req-old", thread.id, "run-old", now)

    await ctx.plugin(sessions)
    await ctx.plugin(providers)

    const row = ctx.storage.db
      .prepare(`SELECT status FROM pending_requests WHERE id = ?`)
      .get("req-old") as { status: string }
    expect(row.status).toBe("orphaned")
    await ctx.fiber.dispose()
  })
})
