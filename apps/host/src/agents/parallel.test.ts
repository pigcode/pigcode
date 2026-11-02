/** 验证不同 thread 的 Claude/Codex run 并行执行，以及全局并发上限。 */
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Thread } from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { ClaudeDriver } from "@pigcode/agent-claude/driver"
import type { ClaudeQueryFn } from "@pigcode/agent-claude/driver"
import { CodexDriver } from "@pigcode/agent-codex/driver"
import { ReplayCodexTransport } from "@pigcode/agent-codex/transport"
import { apply as agentsPlugin } from "./registry"

/** 一个可显式放行的闸门，用来让两个 run 同时停留在运行中。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 测试只关心归一化用到的字段，其余由 SDK 类型约束。 */
function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage
}

/** 在闸门放行前保持挂起的 Claude Query；放行后产生文本与成功结果。 */
function gatedClaudeQuery(gate: Promise<void>, text: string): ClaudeQueryFn {
  return () => {
    async function* generate(): AsyncGenerator<SDKMessage> {
      yield sdkMessage({ type: "system", subtype: "init", session_id: "claude_native" })
      await gate
      yield sdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      })
      yield sdkMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
        session_id: "claude_native",
        modelUsage: {},
        total_cost_usd: 0,
      })
    }
    const iterator = generate()
    return {
      next: () => iterator.next(),
      return: (value?: void) => iterator.return(value),
      throw: (error?: unknown) => iterator.throw(error),
      [Symbol.asyncIterator]() {
        return this
      },
      interrupt: async () => undefined,
    } as unknown as Query
  }
}

/** 客户端发出的 JSON-RPC 消息的最小子集。 */
interface SentMessage {
  id?: number | string
  method?: string
}

/** 按脚本应答 initialize/thread/start，并在闸门放行后完成 turn 的 Codex 传输。 */
class GatedCodexTransport extends ReplayCodexTransport {
  constructor(private readonly gate: Promise<void>) {
    super([])
  }

  override send(line: string): void {
    super.send(line)
    const message = JSON.parse(line) as SentMessage
    if (message.method === "initialize") {
      this.push({ id: message.id, result: {} })
      return
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      this.push({ id: message.id, result: { thread: { id: "th_native" } } })
      return
    }
    if (message.method === "turn/start") {
      this.push({ id: message.id, result: { turn: { id: "turn_1" } } })
      // 与 Claude 共用同一个闸门，保证两个 run 在放行前都处于活跃状态。
      void this.gate.then(() => this.completeTurn())
    }
  }

  /** 闸门放行后推送增量、完整消息与 turn 终态。 */
  private completeTurn(): void {
    this.push({
      method: "item/agentMessage/delta",
      params: { threadId: "th_native", turnId: "turn_1", itemId: "item_msg", delta: "two" },
    })
    this.push({
      method: "item/completed",
      params: {
        threadId: "th_native",
        turnId: "turn_1",
        item: { id: "item_msg", type: "agentMessage", text: "two" },
      },
    })
    this.push({
      method: "turn/completed",
      params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
    })
  }
}

/** 建立带 projects/threads/sessions/agents 的内存 Host。 */
async function setupContext(config: { maxConcurrentRuns?: number } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin, config)
  return ctx
}

/** 建立两个 thread，分别注入 Claude/Codex 的受控 driver。 */
async function setupTwoThreads(): Promise<{
  ctx: Context
  claudeThread: Thread
  codexThread: Thread
  release: () => void
}> {
  const ctx = await setupContext()
  const gate = deferred()
  ctx.agents.register(new ClaudeDriver({ queryFn: gatedClaudeQuery(gate.promise, "one") }))
  ctx.agents.register(
    new CodexDriver({ transportFactory: () => new GatedCodexTransport(gate.promise) }),
  )
  const project = ctx.projects.add("/tmp/pigcode-m2")
  return {
    ctx,
    claudeThread: ctx.threads.create(project.id, "Claude", "claude"),
    codexThread: ctx.threads.create(project.id, "Codex", "codex"),
    release: gate.resolve,
  }
}

describe("parallel runs", () => {
  it("runs claude and codex threads in parallel", async () => {
    const { ctx, claudeThread, codexThread, release } = await setupTwoThreads()
    const a = await ctx.agents.startRun(claudeThread.id, "one")
    const b = await ctx.agents.startRun(codexThread.id, "two")

    // 两个 run 同时活跃：不同 thread 不共享 activeThreads 限制。
    expect(ctx.agents.getRunStatus(a.runId)).toBe("running")
    expect(ctx.agents.getRunStatus(b.runId)).toBe("running")

    release()
    await Promise.all([a.done, b.done])

    expect(ctx.agents.getRunStatus(a.runId)).toBe("completed")
    expect(ctx.agents.getRunStatus(b.runId)).toBe("completed")
    const claudeEvents = ctx.sessions.read(claudeThread.id, 0)
    const codexEvents = ctx.sessions.read(codexThread.id, 0)
    expect(claudeEvents.some((event) => event.type === "run.completed")).toBe(true)
    expect(codexEvents.some((event) => event.type === "run.completed")).toBe(true)
    expect(
      claudeEvents.some(
        (event) =>
          event.type === "message.completed" && (event.payload as { text?: string }).text === "one",
      ),
    ).toBe(true)
    expect(
      codexEvents.some(
        (event) =>
          event.type === "message.completed" && (event.payload as { text?: string }).text === "two",
      ),
    ).toBe(true)
    await ctx.fiber.dispose()
  })

  it("queues a new run when the global limit is reached", async () => {
    const ctx = await setupContext()
    const project = ctx.projects.add("/tmp/pigcode-m2")
    const running: Array<{ runId: string; done: Promise<void> }> = []
    for (let index = 0; index < 4; index += 1) {
      const thread = ctx.threads.create(project.id, `Fake ${index}`, "fake")
      running.push(await ctx.agents.startRun(thread.id, "long"))
    }
    const extra = ctx.threads.create(project.id, "Fake 4", "fake")

    const queued = await ctx.agents.startRun(extra.id, "long")
    expect(ctx.agents.getRunStatus(queued.runId)).toBe("queued")
    expect(ctx.sessions.read(extra.id, 0).some((event) => event.type === "run.queued")).toBe(true)

    ctx.agents.cancelAll()
    await Promise.all([...running.map((run) => run.done), queued.done])
    for (const run of running) {
      expect(ctx.agents.getRunStatus(run.runId)).toBe("interrupted")
    }
    expect(ctx.agents.getRunStatus(queued.runId)).toBe("interrupted")
    await ctx.fiber.dispose()
  })

  it("honors a configured global limit by queueing", async () => {
    const ctx = await setupContext({ maxConcurrentRuns: 1 })
    const project = ctx.projects.add("/tmp/pigcode-m2")
    const firstThread = ctx.threads.create(project.id, "First", "fake")
    const secondThread = ctx.threads.create(project.id, "Second", "fake")

    const first = await ctx.agents.startRun(firstThread.id, "long")
    const second = await ctx.agents.startRun(secondThread.id, "long")
    expect(ctx.agents.getRunStatus(second.runId)).toBe("queued")

    ctx.agents.cancelAll()
    await Promise.all([first.done, second.done])
    expect(ctx.agents.getRunStatus(first.runId)).toBe("interrupted")
    expect(ctx.agents.getRunStatus(second.runId)).toBe("interrupted")
    await ctx.fiber.dispose()
  })
})
