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

  it("renames, removes and restores a project without losing its threads", async () => {
    const ctx = new Context()
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(projects)
    await ctx.plugin(threads)

    const project = ctx.projects.add("/tmp/pigcode-projects", "Original")
    const thread = ctx.threads.create(project.id, "Kept", "fake")
    expect(ctx.projects.add("/tmp/pigcode-projects", "Again")).toEqual(project)

    expect(ctx.projects.rename(project.id, "Renamed")).toEqual({ ...project, name: "Renamed" })
    expect(ctx.projects.remove(project.id)?.id).toBe(project.id)
    expect(ctx.projects.list()).toEqual([])
    expect(ctx.projects.rename(project.id, "Hidden")).toBeUndefined()
    // 移除后会话仍能找到所在项目的目录。
    expect(ctx.projects.get(thread.projectId)?.rootPath).toBe("/tmp/pigcode-projects")

    // 没给新名字时沿用移除前的名字。
    const restored = ctx.projects.add("/tmp/pigcode-projects")
    expect(restored).toEqual({ ...project, name: "Renamed" })
    expect(ctx.projects.list()).toEqual([restored])
    expect(ctx.threads.list(project.id).map((item) => item.id)).toEqual([thread.id])
    ctx.projects.remove(project.id)
    expect(ctx.projects.add("/tmp/pigcode-projects", "Back")).toEqual({ ...project, name: "Back" })
    expect(ctx.projects.remove("missing")).toBeUndefined()
    void ctx.fiber.dispose()
  })
})
