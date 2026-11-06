/** 验证同一线程复用 native session，以及 Host 重启后的 orphan 恢复。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { AgentDriver, AgentSessionHandle } from "./driver"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

/** 记录 createSession 收到的 native id，并像 Claude 一样在首个 run 上报原生会话 id。 */
function resumableDriver(): {
  driver: AgentDriver
  nativeIds: Array<string | null>
} {
  const nativeIds: Array<string | null> = []
  const driver: AgentDriver = {
    id: "resume",
    displayName: "Resume",
    features: new FakeAgentDriver().features,
    async createSession(input) {
      nativeIds.push(input.nativeSessionId ?? null)
      return {
        id: `ps_resume_${nativeIds.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(session: AgentSessionHandle, _input, runtime) {
      // 首次运行没有 native id，模拟 SDK init 消息补充 native-1。
      if (!session.nativeSessionId) session.nativeSessionId = "native-1"
      runtime.emit({ type: "session.started", nativeSessionId: session.nativeSessionId })
      runtime.emit({ type: "message.completed", text: "ok" })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return { driver, nativeIds }
}

/** 建立带 resume 驱动器的内存 Host。 */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const resumable = resumableDriver()
  ctx.agents.register(resumable.driver)
  const project = ctx.projects.add("/tmp/pigcode-m1")
  const thread = ctx.threads.create(project.id, "M1", "resume")
  return { ctx, thread, nativeIds: resumable.nativeIds }
}

describe("session resume", () => {
  it("resumes the same native session", async () => {
    const { ctx, thread, nativeIds } = await setup()
    const first = await ctx.agents.startRun(thread.id, "first")
    await first.done
    const second = await ctx.agents.startRun(thread.id, "second")
    await second.done

    const sessions = ctx.agents.listSessions(thread.id)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.nativeSessionId).toBe("native-1")
    expect(nativeIds).toEqual([null, "native-1"])
    await ctx.fiber.dispose()
  })

  it("recovers after a host restart by orphaning pending state", async () => {
    const { ctx, thread } = await setup()
    const now = new Date().toISOString()
    ctx.storage.db
      .prepare(
        `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run("run-stale", thread.id, "ps-stale", now)
    ctx.storage.db
      .prepare(
        `INSERT INTO agent_sessions
         (id, thread_id, agent_id, native_session_id, cwd, status, created_at, stopped_at)
         VALUES (?, ?, 'resume', 'native-stale', '/tmp/pigcode-m1', 'active', ?, NULL)`,
      )
      .run("ps-stale", thread.id, now)
    ctx.storage.db
      .prepare(
        `INSERT INTO pending_requests
         (id, thread_id, run_id, kind, agent_request_id, payload_json, status, created_at, resolved_at)
         VALUES (?, ?, ?, 'approval', NULL, '{}', 'pending', ?, NULL)`,
      )
      .run("req-stale", thread.id, "run-stale", now)

    const recovered = ctx.agents.recoverAfterRestart()
    expect(recovered).toEqual({
      orphanedRequests: 1,
      interruptedRuns: 1,
      orphanedSessions: 1,
    })
    expect(
      ctx.sessions
        .read(thread.id, 0)
        .some((event) => event.type === "run.interrupted" && event.runId === "run-stale"),
    ).toBe(true)
    // 时间线只显示「已停止」，不说为什么；提示必须落在被打断的那一轮里（monorepo#6 的缺口 B）。
    const notice = ctx.sessions
      .read(thread.id, 0)
      .find((event) => event.type === "notice" && event.runId === "run-stale")
    expect(notice?.payload).toEqual({ level: "warning", key: "host.restarted" })

    const request = ctx.storage.db
      .prepare(`SELECT status FROM pending_requests WHERE id = ?`)
      .get("req-stale") as { status: string }
    expect(request.status).toBe("orphaned")
    const run = ctx.storage.db
      .prepare(`SELECT status, completed_at FROM runs WHERE id = ?`)
      .get("run-stale") as { status: string; completed_at: string | null }
    expect(run.status).toBe("interrupted")
    expect(run.completed_at).not.toBeNull()
    const session = ctx.storage.db
      .prepare(`SELECT status, stopped_at FROM agent_sessions WHERE id = ?`)
      .get("ps-stale") as { status: string; stopped_at: string | null }
    expect(session.status).toBe("orphaned")
    expect(session.stopped_at).not.toBeNull()
    await ctx.fiber.dispose()
  })

  it("includes pending requests in the thread.subscribe snapshot", async () => {
    const { ctx, thread } = await setup()
    const now = new Date().toISOString()
    ctx.storage.db
      .prepare(
        `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run("run-snapshot", thread.id, "ps-snapshot", now)
    const pending = ctx.agents.requestApproval(thread.id, "run-snapshot", {
      toolName: "Bash",
      input: { command: "echo hi" },
    })

    const transport = new MemoryTransport()
    const server = new RpcServer(ctx, transport.host)
    server.start()
    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "thread.subscribe",
      params: { threadId: thread.id, cursor: 0 },
    })
    const response = (await transport.client.next()) as {
      result: { snapshot: { pendingRequests: Array<{ id: string }> } }
    }
    expect(response.result.snapshot.pendingRequests.map((request) => request.id)).toContain(
      pending.requestId,
    )
    server.stop()
    ctx.agents.respondApproval(thread.id, "run-snapshot", pending.requestId, "deny")
    await pending.decision
    await ctx.fiber.dispose()
  })
})
