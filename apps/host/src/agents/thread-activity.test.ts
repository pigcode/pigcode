/**
 * 会话记录跟着 run 走：更新时间、状态与是否未读由 Host 算出，侧栏按它们排序、分组和筛选；
 * 变化推给页面，没打开过的会话也能更新。
 */
import { Context } from "cordis"
import type { Thread } from "@pigcode/contracts"
import { describe, expect, it, vi } from "vitest"
import type { AgentDriver } from "./driver"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

const driver: AgentDriver = {
  id: "quick",
  displayName: "quick",
  features: new FakeAgentDriver().features,
  async createSession(input) {
    return {
      id: input.sessionId ?? "s_1",
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: null,
      permissionMode: "workspace-write",
      model: null,
    }
  },
  async send(_session, _input, runtime) {
    runtime.emit({ type: "message.completed", text: "ok" })
    runtime.emit({ type: "run.completed" })
  },
  interrupt: async () => undefined,
  dispose: async () => undefined,
}

async function createHost() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  ctx.agents.register(driver)
  const project = ctx.projects.add("/tmp/pigcode-activity")
  return { ctx, project }
}

/** 直接写一条还没结束的 run 行，模拟它停在某个状态。 */
function insertRun(ctx: Context, threadId: string, id: string, status: string) {
  ctx.storage.db
    .prepare(
      `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at)
       VALUES (?, ?, 's_1', ?, ?)`,
    )
    .run(id, threadId, status, new Date().toISOString())
}

describe("thread activity", () => {
  it("moves the thread's update time and last run forward when a run starts and ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date("2026-11-20T08:00:00.000Z"))
      const { ctx, project } = await createHost()
      const older = ctx.threads.create(project.id, "older", "quick")
      vi.setSystemTime(new Date("2026-11-20T08:05:00.000Z"))
      const thread = ctx.threads.create(project.id, "newer", "quick")
      expect(ctx.threads.list(project.id).map((item) => item.title)).toEqual(["newer", "older"])

      vi.setSystemTime(new Date("2026-11-21T09:30:00.000Z"))
      const run = await ctx.agents.startRun(older.id, "hi")
      await run.done

      const touched = ctx.threads.get(older.id)
      expect(touched?.updatedAt).toBe("2026-11-21T09:30:00.000Z")
      expect(touched?.lastRunId).toBe(run.runId)
      expect(ctx.threads.get(thread.id)?.updatedAt).toBe("2026-11-20T08:05:00.000Z")
      // 刚跑过的会话排到最前面。
      expect(ctx.threads.list(project.id).map((item) => item.title)).toEqual(["older", "newer"])
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("takes the status from the latest run and counts a finished run as unread until it is read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date("2026-11-21T08:00:00.000Z"))
      const { ctx, project } = await createHost()
      const thread = ctx.threads.create(project.id, "M1", "quick")
      expect(ctx.threads.get(thread.id)).toMatchObject({ status: "idle", unread: false })

      vi.setSystemTime(new Date("2026-11-21T09:00:00.000Z"))
      await (
        await ctx.agents.startRun(thread.id, "hi")
      ).done
      expect(ctx.threads.get(thread.id)).toMatchObject({ status: "completed", unread: true })

      vi.setSystemTime(new Date("2026-11-21T09:05:00.000Z"))
      expect(ctx.threads.markRead(thread.id, true)).toMatchObject({ unread: false })
      expect(ctx.threads.markRead(thread.id, false)).toMatchObject({ unread: true })
      expect(ctx.threads.markAllRead().map((item) => [item.id, item.unread])).toEqual([
        [thread.id, false],
      ])
      expect(ctx.threads.get(thread.id)?.unread).toBe(false)
      expect(ctx.threads.markAllRead()).toEqual([])

      // 跑着或者在等用户的会话不算未读：结果还没出来。
      insertRun(ctx, thread.id, "run-wait", "waiting-input")
      expect(ctx.threads.get(thread.id)).toMatchObject({
        status: "waiting-approval",
        unread: false,
      })
      vi.setSystemTime(new Date("2026-11-21T09:10:00.000Z"))
      ctx.agents.recoverAfterRestart()
      // 重启时等回答的 run 和等审批的一样标成中断，不会一直停在「等你处理」。
      expect(ctx.threads.get(thread.id)).toMatchObject({ status: "interrupted", unread: true })
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("brings an archived thread back together with the subagents archived along with it", async () => {
    const { ctx, project } = await createHost()
    const main = ctx.threads.create(project.id, "main", "quick")
    const child = ctx.threads.create(project.id, "child", "quick", main.id)
    expect(ctx.threads.archive(main.id)?.archivedAt).not.toBeNull()
    expect(ctx.threads.get(child.id)?.archivedAt).not.toBeNull()

    expect(ctx.threads.unarchive(main.id)?.archivedAt).toBeNull()
    expect(ctx.threads.get(child.id)?.archivedAt).toBeNull()
    expect(ctx.threads.unarchive("th_missing")).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it("pushes the new record of any thread that changes, opened in the page or not", async () => {
    const { ctx, project } = await createHost()
    const thread = ctx.threads.create(project.id, "M1", "quick")
    const transport = new MemoryTransport()
    const server = new RpcServer(ctx, transport.host)
    server.start()
    /** 读到满足条件的那条 thread.changed 为止，中间的回复与其他通知跳过。 */
    const changed = async (match: (thread: Thread) => boolean) => {
      for (;;) {
        const message = (await transport.client.next()) as { method?: string; params?: Thread }
        if (message.method === "thread.changed" && message.params && match(message.params)) {
          return message.params
        }
      }
    }

    void ctx.agents.startRun(thread.id, "hi")
    expect(await changed((item) => item.status === "completed")).toMatchObject({
      id: thread.id,
      unread: true,
    })

    transport.client.send({
      jsonrpc: "2.0",
      id: "read",
      method: "thread.markRead",
      params: { threadId: thread.id },
    })
    expect(await changed((item) => item.id === thread.id)).toMatchObject({ unread: false })

    transport.client.send({
      jsonrpc: "2.0",
      id: "archive",
      method: "thread.archive",
      params: { threadId: thread.id },
    })
    await changed((item) => item.archivedAt !== null)
    // 在已归档的会话里接着发消息，会话回到侧栏。
    transport.client.send({
      jsonrpc: "2.0",
      id: "run",
      method: "run.start",
      params: { threadId: thread.id, text: "again" },
    })
    expect(await changed((item) => item.archivedAt === null)).toMatchObject({ id: thread.id })
    expect(await changed((item) => item.status === "completed")).toMatchObject({ unread: true })

    server.stop()
    await ctx.fiber.dispose()
  })
})
