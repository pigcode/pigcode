/** 验证全局运行队列：排队、自动启动、取消排队与状态查询。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import type {
  CreateSessionInput,
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "./driver"
import { FakeProviderDriver } from "./fake"
import { apply as providers } from "./registry"

/** 一个可显式放行的闸门，用来让第一个 run 停留在运行中。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 记录 send 文本，并在闸门放行后才完成 turn 的 fake driver。 */
class GatedFakeDriver extends FakeProviderDriver {
  readonly sent: string[] = []
  readonly created: string[] = []

  constructor(private readonly gate: Promise<void>) {
    super()
  }

  override async createSession(input: CreateSessionInput): Promise<ProviderSessionHandle> {
    this.created.push(input.threadId)
    return super.createSession(input)
  }

  override async send(
    _session: ProviderSessionHandle,
    input: UserInput,
    runtime: ProviderRuntime,
  ): Promise<void> {
    this.sent.push(input.text)
    await this.gate
    runtime.emit({ type: "message.delta", text: input.text })
    runtime.emit({ type: "message.completed", text: input.text })
    runtime.emit({ type: "run.completed" })
  }
}

/** 建立带 projects/threads/sessions/providers 的内存 Host。 */
async function setup(config: { maxConcurrentRuns?: number; maxQueuedRuns?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers, config)
  const gate = deferred()
  const driver = new GatedFakeDriver(gate.promise)
  ctx.providers.register(driver)
  const project = ctx.projects.add("/tmp/pigcode-m5")
  return { ctx, driver, gate, project }
}

describe("run queue", () => {
  it("queues the second thread and starts it after the first completes", async () => {
    const { ctx, driver, gate, project } = await setup({ maxConcurrentRuns: 1 })
    const firstThread = ctx.threads.create(project.id, "First", "fake")
    const secondThread = ctx.threads.create(project.id, "Second", "fake")

    const first = await ctx.providers.startRun(firstThread.id, "first")
    const second = await ctx.providers.startRun(secondThread.id, "second")

    expect(ctx.providers.getRunStatus(first.runId)).toBe("running")
    expect(ctx.providers.getRunStatus(second.runId)).toBe("queued")
    const queuedEvents = ctx.sessions.read(secondThread.id, 0)
    expect(queuedEvents.some((event) => event.type === "run.queued")).toBe(true)
    expect(queuedEvents.some((event) => event.type === "run.started")).toBe(false)
    expect(ctx.providers.listRuns()).toEqual([
      { runId: first.runId, threadId: firstThread.id, status: "running" },
      {
        runId: second.runId,
        threadId: secondThread.id,
        status: "queued",
        queuedAt: expect.any(String),
      },
    ])
    // 排队中的 run 不应调用 driver.send，也不应提前创建 provider 会话。
    expect(driver.sent).toEqual(["first"])
    expect(driver.created).toEqual([firstThread.id])

    gate.resolve()
    await Promise.all([first.done, second.done])

    expect(ctx.providers.getRunStatus(first.runId)).toBe("completed")
    expect(ctx.providers.getRunStatus(second.runId)).toBe("completed")
    expect(driver.sent).toEqual(["first", "second"])
    expect(driver.created).toEqual([firstThread.id, secondThread.id])
    expect(
      ctx.sessions.read(secondThread.id, 0).some((event) => event.type === "run.started"),
    ).toBe(true)
    await ctx.fiber.dispose()
  })

  it("auto-titles a default thread from the first user message", async () => {
    const { ctx, gate, project } = await setup()
    const thread = ctx.threads.create(project.id, "新会话", "fake")

    const run = await ctx.providers.startRun(thread.id, "帮我检查登录流程。再补充测试。")
    gate.resolve()
    await run.done

    expect(ctx.threads.get(thread.id)?.title).toBe("帮我检查登录流程")
    expect(
      ctx.sessions
        .read(thread.id, 0)
        .some(
          (event) =>
            event.type === "thread.updated" &&
            (event.payload as { title?: string }).title === "帮我检查登录流程",
        ),
    ).toBe(true)
    await ctx.fiber.dispose()
  })

  it("still rejects a second run for a thread whose run is queued", async () => {
    const { ctx, gate, project } = await setup({ maxConcurrentRuns: 1 })
    const firstThread = ctx.threads.create(project.id, "First", "fake")
    const secondThread = ctx.threads.create(project.id, "Second", "fake")

    const first = await ctx.providers.startRun(firstThread.id, "first")
    const second = await ctx.providers.startRun(secondThread.id, "second")
    expect(ctx.providers.getRunStatus(second.runId)).toBe("queued")

    await expect(ctx.providers.startRun(secondThread.id, "again")).rejects.toThrow(
      "RUN_ALREADY_ACTIVE",
    )

    gate.resolve()
    await Promise.all([first.done, second.done])
    await ctx.fiber.dispose()
  })

  it("cancels a queued run without executing it", async () => {
    const { ctx, driver, gate, project } = await setup({ maxConcurrentRuns: 1 })
    const firstThread = ctx.threads.create(project.id, "First", "fake")
    const secondThread = ctx.threads.create(project.id, "Second", "fake")

    const first = await ctx.providers.startRun(firstThread.id, "first")
    const second = await ctx.providers.startRun(secondThread.id, "second")

    expect(ctx.providers.cancelRun(second.runId)).toBe(true)
    await second.done
    expect(ctx.providers.getRunStatus(second.runId)).toBe("interrupted")
    expect(
      ctx.sessions.read(secondThread.id, 0).some((event) => event.type === "run.interrupted"),
    ).toBe(true)
    expect(driver.sent).toEqual(["first"])
    expect(driver.created).toEqual([firstThread.id])
    expect(ctx.providers.listRuns()).toEqual([
      { runId: first.runId, threadId: firstThread.id, status: "running" },
    ])

    // 第一个结束后队列已空，被取消的 run 不会启动。
    expect(ctx.providers.cancelRun(first.runId)).toBe(true)
    gate.resolve()
    await first.done
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(driver.sent).toEqual(["first"])
    await ctx.fiber.dispose()
  })

  it("rejects a run when the queue is full", async () => {
    const { ctx, gate, project } = await setup({ maxConcurrentRuns: 1, maxQueuedRuns: 1 })
    const runningThread = ctx.threads.create(project.id, "Running", "fake")
    const queuedThread = ctx.threads.create(project.id, "Queued", "fake")
    const extraThread = ctx.threads.create(project.id, "Extra", "fake")

    const running = await ctx.providers.startRun(runningThread.id, "first")
    const queued = await ctx.providers.startRun(queuedThread.id, "second")
    expect(ctx.providers.getRunStatus(queued.runId)).toBe("queued")

    await expect(ctx.providers.startRun(extraThread.id, "third")).rejects.toThrow("RUN_QUEUE_FULL")
    expect(ctx.providers.listRuns()).toHaveLength(2)

    ctx.providers.cancelAll()
    gate.resolve()
    await Promise.all([running.done, queued.done])
    expect(ctx.providers.getRunStatus(running.runId)).toBe("interrupted")
    expect(ctx.providers.getRunStatus(queued.runId)).toBe("interrupted")
    expect(ctx.providers.listRuns()).toEqual([])
    await ctx.fiber.dispose()
  })
})
