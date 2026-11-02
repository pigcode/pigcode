/** 验证 RPC 线程订阅不会重复累积监听器，且 thread.unsubscribe 后停止推送。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { ThreadEvent } from "@pigcode/contracts"
import { apply as agentsPlugin } from "../agents/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

/** Host 收到的下一条 RPC 消息。 */
interface RpcMessage {
  id?: string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

/** 构造一条线程事件；seq 由调用方指定。 */
function threadEvent(threadId: string, seq: number): ThreadEvent {
  return {
    seq,
    threadId,
    runId: null,
    type: "run.started",
    payload: {},
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  }
}

/** 等待一小段时间；用于断言“没有更多消息”。 */
function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

/** 建立带 agents 服务的内存 Host。 */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const project = ctx.projects.add("/tmp/pigcode-m5")
  const thread = ctx.threads.create(project.id, "M5", "fake")
  const transport = new MemoryTransport()
  const server = new RpcServer(ctx, transport.host)
  server.start()
  return { ctx, thread, transport, server }
}

/** 订阅线程并消费响应。 */
async function subscribe(
  transport: MemoryTransport,
  threadId: string,
  id: string,
): Promise<RpcMessage> {
  transport.client.send({
    jsonrpc: "2.0",
    id,
    method: "thread.subscribe",
    params: { threadId, cursor: 0 },
  })
  return (await transport.client.next()) as RpcMessage
}

describe("thread subscription rpc", () => {
  it("does not accumulate listeners when the same thread is subscribed twice", async () => {
    const { ctx, thread, transport, server } = await setup()
    const first = await subscribe(transport, thread.id, "sub-1")
    expect(first).toMatchObject({ id: "sub-1", result: { events: [] } })
    const second = await subscribe(transport, thread.id, "sub-2")
    expect(second).toMatchObject({ id: "sub-2" })

    ctx.sessions.append(threadEvent(thread.id, 1))

    const delivered = await transport.client.next()
    expect(delivered).toMatchObject({
      method: "thread.event",
      params: { threadId: thread.id, seq: 1 },
    })
    await expect(Promise.race([transport.client.next(), delay(25)])).resolves.toBeNull()

    server.stop()
    await ctx.fiber.dispose()
  })

  it("stops delivering events after thread.unsubscribe", async () => {
    const { ctx, thread, transport, server } = await setup()
    await subscribe(transport, thread.id, "sub-1")

    transport.client.send({
      jsonrpc: "2.0",
      id: "unsub-1",
      method: "thread.unsubscribe",
      params: { threadId: thread.id },
    })
    const unsubscribed = await transport.client.next()
    expect(unsubscribed).toMatchObject({ id: "unsub-1", result: { ok: true } })

    ctx.sessions.append(threadEvent(thread.id, 1))
    await expect(Promise.race([transport.client.next(), delay(25)])).resolves.toBeNull()

    server.stop()
    await ctx.fiber.dispose()
  })
})
