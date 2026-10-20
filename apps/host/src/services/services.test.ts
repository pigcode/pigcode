import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

describe("host services", () => {
  it("creates a project and thread, then appends a session event", async () => {
    const ctx = new Context()
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)

    const project = ctx.projects.add("/tmp/pigcode-workspace")
    const thread = ctx.threads.create(project.id, "First thread", "fake")
    const event = ctx.sessions.append({
      threadId: thread.id,
      runId: null,
      type: "thread.created",
      payload: { title: thread.title },
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    })

    expect(ctx.projects.list()).toHaveLength(1)
    expect(ctx.threads.list(project.id)).toHaveLength(1)
    expect(ctx.sessions.read(thread.id, 0)[0]!.seq).toBe(event.seq)
    void ctx.fiber.dispose()
  })
})
