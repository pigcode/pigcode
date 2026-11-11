/** Host 重启后接回原生会话；原生会话已经不存在时改开新会话并带上交接（#74）。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { AgentDriver, UserInput } from "./driver"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"
import { AgentSessionStore } from "./session-store"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

const MISSING = "No conversation found with session ID: native-1"

/**
 * 记录 createSession 收到的 native id 和 send 收到的输入。lose 决定原生会话 native-1 不在时在哪里报错：
 * Codex 在 createSession（thread/resume），Claude 在 send。
 */
function driverWith(lose: "none" | "create" | "send") {
  const nativeIds: Array<string | null> = []
  const inputs: UserInput[] = []
  let next = 0
  const driver: AgentDriver = {
    id: "resume",
    displayName: "Resume",
    features: new FakeAgentDriver().features,
    async createSession(input) {
      nativeIds.push(input.nativeSessionId ?? null)
      if (lose === "create" && input.nativeSessionId === "native-1") throw new Error(MISSING)
      return {
        id: input.sessionId ?? `ps_${(next += 1)}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(session, input, runtime) {
      inputs.push(input)
      if (lose === "send" && session.nativeSessionId === "native-1") {
        // 真实 Claude 连发两条：先是 error result（带 errors），再是 SDK 抛出的异常。
        runtime.emit({ type: "run.failed", message: `error_during_execution: ${MISSING}` })
        runtime.emit({
          type: "run.failed",
          message: `Claude Code returned an error result: ${MISSING}`,
        })
        return
      }
      if (!session.nativeSessionId) session.nativeSessionId = `native-${inputs.length}`
      runtime.emit({ type: "session.started", nativeSessionId: session.nativeSessionId })
      runtime.emit({ type: "message.completed", text: `answer ${inputs.length}` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
    isSessionNotFound: (message) => message.includes("No conversation found"),
  }
  return { driver, nativeIds, inputs }
}

async function setup(lose: "none" | "create" | "send") {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const fake = driverWith(lose)
  ctx.agents.register(fake.driver)
  const project = ctx.projects.add("/tmp/pigcode-resume")
  const thread = ctx.threads.create(project.id, "T", "resume")
  const store = new AgentSessionStore(ctx.storage.db)
  /** 跑一次 run 并等它结束。 */
  const run = async (text: string) => (await ctx.agents.startRun(thread.id, text)).done
  /** 模拟 Host 重启：重启时 restart.ts 把活跃会话标成 orphaned。 */
  const restart = () => store.orphanActive(new Date().toISOString())
  return { ctx, thread, run, restart, ...fake }
}

describe("resuming native sessions", () => {
  it("resumes the same native session after a host restart", async () => {
    const { ctx, thread, run, restart, nativeIds, inputs } = await setup("none")
    await run("first")
    restart()
    await run("second")

    expect(nativeIds).toEqual([null, "native-1"])
    expect(inputs[1]?.handoff).toBeUndefined()
    const rows = ctx.agents.listSessions(thread.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("active")
    await ctx.fiber.dispose()
  })

  for (const lose of ["create", "send"] as const) {
    it(`starts a new session with a handoff when resume fails in ${lose}`, async () => {
      const { ctx, thread, run, restart, nativeIds, inputs } = await setup(lose)
      await run("build the parser")
      restart()
      await run("now add tests")

      // 第二轮先试着接回 native-1，失败后不带原生 id 再开一次。
      expect(nativeIds.slice(1)).toEqual(["native-1", null])
      const last = inputs.at(-1)!
      expect(last.text).toBe("now add tests")
      expect(last.handoff).toContain("build the parser")
      expect(last.handoff).toContain("answer 1")
      // 这一轮自己的输入不重复放进交接。
      expect(last.handoff).not.toContain("now add tests")

      const events = ctx.sessions.read(thread.id, 0)
      expect(events.filter((event) => event.type === "run.failed")).toHaveLength(0)
      expect(
        events.some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { key?: string }).key === "session.resumeFailed",
        ),
      ).toBe(true)
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(2)

      const rows = ctx.agents.listSessions(thread.id)
      expect(rows.map((row) => row.status)).toEqual(["stopped", "active"])

      // 再下一轮直接接新会话，不再碰已经停掉的那个。
      await run("and docs")
      expect(nativeIds.at(-1)).not.toBe("native-1")
      expect(inputs.at(-1)?.handoff).toBeUndefined()
      await ctx.fiber.dispose()
    })
  }

  it("still fails a run whose error is not a missing session", async () => {
    const { ctx, thread, driver } = await setup("none")
    driver.send = async (_session, _input, runtime) => {
      runtime.emit({ type: "run.failed", message: "rate limited" })
    }
    await (
      await ctx.agents.startRun(thread.id, "hi")
    ).done
    const failed = ctx.sessions.read(thread.id, 0).filter((event) => event.type === "run.failed")
    expect(failed).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
