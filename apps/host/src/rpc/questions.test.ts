/** 验证 agent 提问：写 question.requested、等用户回答、答案交回 driver；run 结束时问题以空答案收尾。 */
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import { apply as providers } from "../providers/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const transport = new MemoryTransport()
  new RpcServer(ctx, transport.host).start()
  const project = ctx.projects.add("/tmp/pigcode-questions")
  const thread = ctx.threads.create(project.id, "提问", "fake")
  let id = 0
  const call = async (method: string, params: unknown) => {
    id += 1
    transport.client.send({ jsonrpc: "2.0", id: String(id), method, params })
    for (;;) {
      const message = (await transport.client.next()) as {
        id?: string
        result?: unknown
        error?: { message: string }
      }
      if (message.id !== String(id)) continue
      if (message.error) throw new Error(message.error.message)
      return message.result
    }
  }
  const events = () => ctx.sessions.read(thread.id, 0)
  const pendingQuestion = () =>
    events().find((event) => event.type === "question.requested")?.payload as
      { id: string; questions: Array<{ question: string; multiSelect: boolean }> } | undefined
  return { ctx, thread, call, events, pendingQuestion }
}

describe("agent questions", () => {
  it("wait for the user's answers and hand them back to the agent", async () => {
    const { ctx, thread, call, events, pendingQuestion } = await setup()
    const { runId } = (await call("run.start", { threadId: thread.id, text: "ask" })) as {
      runId: string
    }
    await vi.waitFor(() => expect(pendingQuestion()).toBeDefined())
    const request = pendingQuestion()!
    expect(request.questions.map((question) => [question.question, question.multiSelect])).toEqual([
      ["这次改动要覆盖哪些平台？", true],
      ["测试用哪个框架？", false],
    ])
    expect(ctx.providers.getRunStatus(runId)).toBe("waiting-input")
    expect(ctx.providers.listPendingRequests(thread.id)).toMatchObject([
      { id: request.id, kind: "question" },
    ])

    await expect(
      call("run.answerQuestion", {
        threadId: thread.id,
        runId: "run_other",
        requestId: request.id,
        answers: ["x"],
      }),
    ).rejects.toThrow("question not pending")
    await call("run.answerQuestion", {
      threadId: thread.id,
      runId,
      requestId: request.id,
      answers: ["macOS, Linux", "Vitest"],
    })

    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(0))
    expect(events().find((event) => event.type === "question.answered")?.payload).toEqual({
      requestId: request.id,
      id: request.id,
      answers: ["macOS, Linux", "Vitest"],
    })
    const reply = events()
      .filter((event) => event.type === "message.completed")
      .at(-1)?.payload as { text: string }
    expect(reply.text).toBe("好的：平台 macOS, Linux，测试用 Vitest。")
    expect(ctx.providers.listPendingRequests(thread.id)).toEqual([])
    await ctx.fiber.dispose()
  })

  it("end unanswered questions when the run is interrupted", async () => {
    const { ctx, thread, call, events, pendingQuestion } = await setup()
    const { runId } = (await call("run.start", { threadId: thread.id, text: "ask" })) as {
      runId: string
    }
    await vi.waitFor(() => expect(pendingQuestion()).toBeDefined())
    await call("run.interrupt", { threadId: thread.id, runId })
    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(0))
    expect(events().find((event) => event.type === "question.answered")?.payload).toMatchObject({
      answers: [],
      reason: "run-ended",
    })
    expect(events().at(-1)?.type).toBe("run.interrupted")
    await ctx.fiber.dispose()
  })
})
