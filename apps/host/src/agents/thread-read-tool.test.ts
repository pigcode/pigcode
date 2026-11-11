/** 内置 MCP 工具 thread_read（#80）：没装插件也在，按位置分页，长条目可以接着读。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { AgentDriver, SessionMcp } from "./driver"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"
import { apply as mcpBridge } from "../services/mcp-bridge"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

/** 记下每次建会话拿到的 MCP 配置；每轮回答一段长文字。 */
function recordingDriver(): { driver: AgentDriver; mcps: Array<SessionMcp | undefined> } {
  const mcps: Array<SessionMcp | undefined> = []
  const driver: AgentDriver = {
    id: "rec",
    displayName: "rec",
    features: new FakeAgentDriver().features,
    async createSession(input) {
      mcps.push(input.mcp)
      return {
        id: `s_${mcps.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }
    },
    async send(_session, input, runtime) {
      runtime.emit({
        type: "message.completed",
        text: `answer to ${input.text} ${"z".repeat(300)}`,
      })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return { driver, mcps }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(mcpBridge)
  await ctx.plugin(agentsPlugin)
  const rec = recordingDriver()
  ctx.agents.register(rec.driver)
  const project = ctx.projects.add("/tmp/pigcode-thread-read")
  const thread = ctx.threads.create(project.id, "解析器", "rec")
  return { ctx, project, thread, ...rec }
}

type Page = {
  thread: { id: string; title: string; project: string | null; archived: boolean }
  items: Array<{
    id: string
    position: number
    kind: string
    text: string
    nextTextOffset: number | null
  }>
  nextPosition: number | null
}

describe("thread_read", () => {
  it("is offered to every session even without plugin tools", async () => {
    const { ctx, thread, mcps } = await setup()
    await (
      await ctx.agents.startRun(thread.id, "hello")
    ).done
    expect(mcps[0]?.tools.map((tool) => tool.name)).toEqual(["thread_read"])
    await ctx.fiber.dispose()
  })

  it("pages through a conversation and continues a long item", async () => {
    const { ctx, thread, mcps } = await setup()
    for (const text of ["one", "two", "three"])
      await (
        await ctx.agents.startRun(thread.id, text)
      ).done
    const call = async (input: unknown) => (await mcps[0]!.callTool("thread_read", input)) as Page

    // 不给 threadId 时读调用者自己的会话。
    const first = await call({ limit: 4 })
    expect(first.thread).toMatchObject({
      id: thread.id,
      title: "解析器",
      project: "/tmp/pigcode-thread-read",
    })
    expect(first.items.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ])
    expect(first.nextPosition).toBe(first.items.at(-1)!.position)
    const second = await call({ afterPosition: first.nextPosition, limit: 4 })
    expect(second.items.map((item) => item.text.slice(0, 13))).toEqual(["three", "answer to thr"])
    expect(second.nextPosition).toBeNull()

    const answer = first.items[1]!
    const cut = await call({ itemId: answer.id, maxCharsPerItem: 200 })
    expect(cut.items[0]!.text).toHaveLength(200)
    expect(cut.items[0]!.nextTextOffset).toBe(200)
    const rest = await call({ itemId: answer.id, textOffset: 200, maxCharsPerItem: 1000 })
    expect(cut.items[0]!.text + rest.items[0]!.text).toBe(`answer to one ${"z".repeat(300)}`)
    expect(rest.items[0]!.nextTextOffset).toBeNull()
    await ctx.fiber.dispose()
  })

  it("reads another conversation by id and rejects one that does not exist", async () => {
    const { ctx, project, thread, mcps } = await setup()
    const other = ctx.threads.create(project.id, "另一个", "rec")
    await (
      await ctx.agents.startRun(other.id, "elsewhere")
    ).done
    await (
      await ctx.agents.startRun(thread.id, "here")
    ).done
    const tool = mcps.at(-1)!
    const page = (await tool.callTool("thread_read", { threadId: other.id })) as Page
    expect(page.items[0]?.text).toBe("elsewhere")
    await expect(tool.callTool("thread_read", { threadId: "nope" })).rejects.toThrow(
      "thread not found: nope",
    )
    await ctx.fiber.dispose()
  })

  it("does not ask the user to approve it, but still asks for other tools", async () => {
    const { ctx, thread, driver } = await setup()
    const decisions: string[] = []
    driver.send = async (_session, _input, runtime) => {
      decisions.push(
        await runtime.requestApproval({ toolName: "mcp__pigcode__thread_read", input: {} }),
      )
      // 别的工具照常等界面审批；这里不等它，只看事件里有没有审批请求。
      void runtime.requestApproval({ toolName: "Bash", input: { command: "rm -rf x" } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      runtime.emit({ type: "run.completed" })
    }
    await (
      await ctx.agents.startRun(thread.id, "read it")
    ).done
    expect(decisions).toEqual(["allow-once"])
    const asked = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "approval.requested")
      .map((event) => (event.payload as { toolName: string }).toolName)
    expect(asked).toEqual(["Bash"])
    await ctx.fiber.dispose()
  })
})
