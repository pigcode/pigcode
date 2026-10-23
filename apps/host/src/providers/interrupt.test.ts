/** 验证 run 中断、Host 退出清理、以及 Claude Query 的 abort 传播。 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderEvent, ThreadEvent } from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { ProviderRuntime } from "./driver"
import { ClaudeDriver } from "@pigcode/provider-claude/driver"
import type { ClaudeQueryFn } from "@pigcode/provider-claude/driver"
import { apply as providers } from "./registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

/** 建立带 fake provider 的内存 Host。 */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const project = ctx.projects.add("/tmp/pigcode-m1")
  const thread = ctx.threads.create(project.id, "M1", "fake")
  return { ctx, thread, project }
}

/** 轮询到条件成立，最多等待约 100ms；避免依赖固定 sleep。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition not met")
}

/** 一条最小的 SDK 消息；测试只关心归一化用到的字段。 */
function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage
}

/** 受控的 Query：interrupt 后放行剩余消息，用于验证消费端不再 emit。 */
function controlledQuery(): { query: Query; interruptCalls: () => number } {
  let interruptCount = 0
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  async function* generate(): AsyncGenerator<SDKMessage> {
    yield sdkMessage({ type: "system", subtype: "init", session_id: "native-test" })
    yield sdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "first" } },
    })
    await released
    // 中断后仍会产生消息，但 driver 已停止消费，不应再 emit。
    yield sdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "after-abort" } },
    })
  }

  const iterator = generate()
  const query = {
    next: () => iterator.next(),
    return: (value?: void) => iterator.return(value),
    throw: (error?: unknown) => iterator.throw(error),
    [Symbol.asyncIterator]() {
      return this
    },
    interrupt: async () => {
      interruptCount += 1
      release()
      return undefined
    },
  } as unknown as Query
  return { query, interruptCalls: () => interruptCount }
}

/** 构造直连 ClaudeDriver 的 send 调用，便于观察事件与 abort 行为。 */
async function startClaudeSend(): Promise<{
  driver: ClaudeDriver
  session: Awaited<ReturnType<ClaudeDriver["createSession"]>>
  send: Promise<void>
  abort: () => void
  events: ProviderEvent[]
  interruptCalls: () => number
}> {
  const controlled = controlledQuery()
  const queryFn: ClaudeQueryFn = () => controlled.query
  const driver = new ClaudeDriver({ queryFn })
  const session = await driver.createSession({ threadId: "thread-test", cwd: "/tmp/pigcode-m1" })
  const controller = new AbortController()
  const events: ProviderEvent[] = []
  const runtime: ProviderRuntime = {
    signal: controller.signal,
    emit: (event) => events.push(event),
    requestApproval: async () => "allow-once",
  }
  const send = driver.send(session, { text: "hello" }, runtime)
  return {
    driver,
    session,
    send,
    abort: () => controller.abort(),
    events,
    interruptCalls: controlled.interruptCalls,
  }
}

describe("run interrupt", () => {
  it("interrupts an active fake run", async () => {
    const { ctx, thread } = await setup()
    const { runId, done } = await ctx.providers.startRun(thread.id, "long")
    ctx.providers.cancelRun(runId)
    await done
    expect(ctx.providers.getRunStatus(runId)).toBe("interrupted")
    const events = ctx.sessions.read(thread.id, 0)
    expect(events.some((event) => event.type === "run.interrupted")).toBe(true)
    await ctx.fiber.dispose()
  })

  it("keeps the streamed partial reply as a message before run.interrupted", async () => {
    const { ctx, thread } = await setup()
    const { runId, done } = await ctx.providers.startRun(thread.id, "long")
    await new Promise((resolve) => setTimeout(resolve, 20))
    ctx.providers.cancelRun(runId)
    await done

    const events = ctx.sessions.read(thread.id, 0)
    const partialIndex = events.findIndex(
      (event) =>
        event.type === "message.completed" &&
        (event.payload as { partial?: boolean }).partial === true,
    )
    const interruptedIndex = events.findIndex((event) => event.type === "run.interrupted")
    expect(partialIndex).toBeGreaterThan(-1)
    expect(partialIndex).toBeLessThan(interruptedIndex)
    expect((events[partialIndex]?.payload as { text: string }).text).toMatch(/^\.+$/)
    await ctx.fiber.dispose()
  })

  it("adds no partial message when a completed run is followed by nothing", async () => {
    const { ctx, thread } = await setup()
    const { done } = await ctx.providers.startRun(thread.id, "hello")
    await done
    const partials = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => (event.payload as { partial?: boolean } | null)?.partial === true)
    expect(partials).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it("allows a new run after the previous one is interrupted", async () => {
    const { ctx, thread } = await setup()
    const first = await ctx.providers.startRun(thread.id, "long")
    ctx.providers.cancelRun(first.runId)
    await first.done

    const second = await ctx.providers.startRun(thread.id, "hello")
    await second.done
    expect(ctx.providers.getRunStatus(second.runId)).toBe("completed")
    await ctx.fiber.dispose()
  })

  it("cancels every active run when the host shuts down", async () => {
    const { ctx, thread, project } = await setup()
    const other = ctx.threads.create(project.id, "Other", "fake")
    const first = await ctx.providers.startRun(thread.id, "long")
    const second = await ctx.providers.startRun(other.id, "long")

    ctx.providers.cancelAll()
    await Promise.all([first.done, second.done])

    expect(ctx.providers.getRunStatus(first.runId)).toBe("interrupted")
    expect(ctx.providers.getRunStatus(second.runId)).toBe("interrupted")
    expect(ctx.sessions.read(thread.id, 0).some((event) => event.type === "run.interrupted")).toBe(
      true,
    )
    await ctx.fiber.dispose()
  })

  it("interrupts active runs when the host context is disposed", async () => {
    const { ctx, thread } = await setup()
    const seen: ThreadEvent[] = []
    ctx.sessions.subscribe(thread.id, (event) => seen.push(event))
    const { done } = await ctx.providers.startRun(thread.id, "long")

    await ctx.fiber.dispose()
    await done

    expect(seen.some((event) => event.type === "run.interrupted")).toBe(true)
  })

  it("calls Query.interrupt and stops consuming when the run aborts", async () => {
    const { send, abort, events, interruptCalls } = await startClaudeSend()
    await waitFor(() => events.some((event) => event.type === "message.delta"))

    abort()
    await send

    expect(interruptCalls()).toBe(1)
    expect(
      events.some((event) => event.type === "message.delta" && event.text === "after-abort"),
    ).toBe(false)
  })

  it("interrupts the active query through driver.interrupt", async () => {
    const { driver, session, send, events, interruptCalls } = await startClaudeSend()
    await waitFor(() => events.some((event) => event.type === "message.delta"))

    // 直接调用 driver 的中断入口，验证它同样会结束当前 Query。
    await driver.interrupt(session)
    await send

    expect(interruptCalls()).toBe(1)
  })
})
