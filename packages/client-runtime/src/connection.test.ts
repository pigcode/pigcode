/** 验证连接从 snapshot/cursor 恢复线程事件，并维护每线程订阅。 */
import { describe, expect, it } from "vitest"
import type { ThreadEvent } from "@pigcode/contracts"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { Connection } from "./connection"

/** Host 收到的一条 RPC 请求。 */
interface HostRequest {
  id?: string
  method?: string
  params?: Record<string, unknown>
}

/** 构造一条线程事件；seq 由调用方指定。 */
function threadEvent(threadId: string, seq: number, type: ThreadEvent["type"]): ThreadEvent {
  return {
    seq,
    threadId,
    runId: "run_1",
    type,
    payload: {},
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  }
}

/** 读取 Host 收到的下一条请求。 */
async function nextRequest(transport: MemoryTransport): Promise<HostRequest> {
  return (await transport.host.next()) as HostRequest
}

/** 给请求发送成功响应。 */
function respond(transport: MemoryTransport, request: HostRequest, result: unknown): void {
  transport.host.send({ jsonrpc: "2.0", id: request.id, result })
}

/** 订阅一个线程并立即返回空快照。 */
async function open(connection: Connection, transport: MemoryTransport, threadId: string) {
  const pending = connection.openThread(threadId)
  const request = await nextRequest(transport)
  expect(request.method).toBe("thread.subscribe")
  respond(transport, request, { snapshot: {}, cursor: 0, events: [] })
  await pending
  return request
}

describe("Connection", () => {
  it("resubscribes from the last cursor", async () => {
    const transport = new MemoryTransport()
    const events: number[] = []
    const connection = new Connection({
      onEvent: (event) => events.push(event.seq),
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    const pending = connection.openThread("th_1")
    const request = (await transport.host.next()) as {
      id: string
      method: string
      params: { cursor: number }
    }
    expect(request.method).toBe("thread.subscribe")
    transport.host.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { snapshot: {}, cursor: 2, events: [{ seq: 2 }] },
    })
    await pending
    expect(events).toEqual([2])
  })

  it("dispatches terminal output until unsubscribed", async () => {
    const transport = new MemoryTransport()
    const outputs: Array<{ terminalId: string; data: string }> = []
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    const off = connection.onTerminalOutput((output) => outputs.push(output))
    transport.host.send({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: "term_1", data: "hello" },
    })
    expect(outputs).toEqual([{ terminalId: "term_1", data: "hello" }])
    off()
    transport.host.send({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: "term_1", data: "ignored" },
    })
    expect(outputs).toHaveLength(1)
  })

  it("dispatches terminal exits so the tab can close", async () => {
    const transport = new MemoryTransport()
    const exits: Array<{ terminalId: string; exitCode: number }> = []
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    const off = connection.onTerminalExit((exit) => exits.push(exit))
    transport.host.send({
      jsonrpc: "2.0",
      method: "terminal.exit",
      params: { terminalId: "term_1", exitCode: 130 },
    })
    expect(exits).toEqual([{ terminalId: "term_1", exitCode: 130 }])
    off()
    transport.host.send({ jsonrpc: "2.0", method: "terminal.exit", params: { terminalId: "x" } })
    expect(exits).toHaveLength(1)
  })

  it("opens two threads and routes notifications by threadId", async () => {
    const transport = new MemoryTransport()
    const events: Array<{ threadId: string; seq: number }> = []
    const deltas: Array<{ threadId: string; type: string }> = []
    const connection = new Connection({
      onEvent: (event) => events.push({ threadId: event.threadId, seq: event.seq }),
      onDelta: (delta) => deltas.push({ threadId: delta.threadId, type: delta.event.type }),
      onStatus: () => {},
    })
    await connection.attach(transport.client)

    const first = connection.openThread("th_1")
    const firstRequest = await nextRequest(transport)
    respond(transport, firstRequest, {
      snapshot: {},
      cursor: 1,
      events: [threadEvent("th_1", 1, "run.started")],
    })
    await first

    const second = connection.openThread("th_2")
    const secondRequest = await nextRequest(transport)
    respond(transport, secondRequest, {
      snapshot: {},
      cursor: 1,
      events: [threadEvent("th_2", 1, "run.started")],
    })
    await second

    transport.host.send({
      jsonrpc: "2.0",
      method: "thread.event",
      params: threadEvent("th_1", 2, "message.completed"),
    })
    transport.host.send({
      jsonrpc: "2.0",
      method: "thread.event",
      params: threadEvent("th_2", 2, "message.completed"),
    })
    transport.host.send({
      jsonrpc: "2.0",
      method: "thread.delta",
      params: { threadId: "th_2", event: { type: "message.delta", text: "hi" } },
    })

    expect(events).toEqual([
      { threadId: "th_1", seq: 1 },
      { threadId: "th_2", seq: 1 },
      { threadId: "th_1", seq: 2 },
      { threadId: "th_2", seq: 2 },
    ])
    expect(deltas).toEqual([{ threadId: "th_2", type: "message.delta" }])
  })

  it("hands over each replay with its thread, even when the replay is empty", async () => {
    const transport = new MemoryTransport()
    const replays: Array<{ threadId: string; seqs: number[] }> = []
    const connection = new Connection({
      onEvent: () => {},
      onEvents: (events, threadId) =>
        replays.push({ threadId, seqs: events.map((event) => event.seq) }),
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_empty")
    const pending = connection.openThread("th_1")
    respond(transport, await nextRequest(transport), {
      snapshot: {},
      cursor: 1,
      events: [threadEvent("th_1", 1, "thread.created")],
    })
    await pending
    expect(replays).toEqual([
      { threadId: "th_empty", seqs: [] },
      { threadId: "th_1", seqs: [1] },
    ])
  })

  it("ignores events and deltas after a thread is closed", async () => {
    const transport = new MemoryTransport()
    const events: ThreadEvent[] = []
    const deltas: string[] = []
    const connection = new Connection({
      onEvent: (event) => events.push(event),
      onDelta: (delta) => deltas.push(delta.threadId),
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    const closing = connection.closeThread("th_1")
    const unsubscribe = await nextRequest(transport)
    expect(unsubscribe.method).toBe("thread.unsubscribe")
    respond(transport, unsubscribe, {})
    await closing

    transport.host.send({
      jsonrpc: "2.0",
      method: "thread.event",
      params: threadEvent("th_1", 2, "message.completed"),
    })
    transport.host.send({
      jsonrpc: "2.0",
      method: "thread.delta",
      params: { threadId: "th_1", event: { type: "message.delta", text: "late" } },
    })

    expect(events).toEqual([])
    expect(deltas).toEqual([])
  })

  it("resumes every thread cursor after reconnect", async () => {
    const transport = new MemoryTransport()
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)

    const firstOpen = connection.openThread("th_1")
    const firstSubscribe = await nextRequest(transport)
    respond(transport, firstSubscribe, {
      snapshot: {},
      cursor: 1,
      events: [threadEvent("th_1", 1, "run.started")],
    })
    await firstOpen

    const secondOpen = connection.openThread("th_2")
    const secondSubscribe = await nextRequest(transport)
    respond(transport, secondSubscribe, {
      snapshot: {},
      cursor: 1,
      events: [threadEvent("th_2", 1, "run.started")],
    })
    await secondOpen

    transport.host.send({
      jsonrpc: "2.0",
      method: "thread.event",
      params: threadEvent("th_1", 2, "run.completed"),
    })

    const resumed = new MemoryTransport()
    const attaching = connection.attach(resumed.client)

    const firstRequest = await nextRequest(resumed)
    expect(firstRequest.params).toEqual({ threadId: "th_1", cursor: 2 })
    respond(resumed, firstRequest, { snapshot: {}, cursor: 2, events: [] })

    const secondRequest = await nextRequest(resumed)
    expect(secondRequest.params).toEqual({ threadId: "th_2", cursor: 1 })
    respond(resumed, secondRequest, { snapshot: {}, cursor: 1, events: [] })

    await attaching
  })

  it("starts a run in the thread passed by the caller", async () => {
    const transport = new MemoryTransport()
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    const pending = connection.startRun("th_2", "hello")
    const request = await nextRequest(transport)
    expect(request.method).toBe("run.start")
    expect(request.params).toEqual({ threadId: "th_2", text: "hello" })
    respond(transport, request, { runId: "run_2" })
    await pending
  })

  it("unsubscribes the host when a thread is closed", async () => {
    const transport = new MemoryTransport()
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    const pending = connection.closeThread("th_1")
    const request = await nextRequest(transport)
    expect(request.method).toBe("thread.unsubscribe")
    expect(request.params).toEqual({ threadId: "th_1" })
    respond(transport, request, { ok: true })
    await pending
  })

  it("keeps the newest cursor when a replay lands after live events", async () => {
    const transport = new MemoryTransport()
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    const resumed = new MemoryTransport()
    const attaching = connection.attach(resumed.client)
    const subscribe = await nextRequest(resumed)
    // 回放还没返回，新连接已经推来 seq 5 的事件。
    resumed.host.send({
      jsonrpc: "2.0",
      method: "thread.event",
      params: threadEvent("th_1", 5, "run.completed"),
    })
    respond(resumed, subscribe, { snapshot: {}, cursor: 0, events: [] })
    await attaching

    // 下一次重连仍从 seq 5 开始：迟到的回放不能把 cursor 拉回去。
    const again = new MemoryTransport()
    const reattaching = connection.attach(again.client)
    const next = await nextRequest(again)
    expect(next.params).toEqual({ threadId: "th_1", cursor: 5 })
    respond(again, next, { snapshot: {}, cursor: 5, events: [] })
    await reattaching
  })

  it("drops a replay for a thread closed while it was loading", async () => {
    const transport = new MemoryTransport()
    const events: number[] = []
    const connection = new Connection({
      onEvent: (event) => events.push(event.seq),
      onDelta: () => {},
      onStatus: () => {},
    })
    await connection.attach(transport.client)

    const opening = connection.openThread("th_1")
    const subscribe = await nextRequest(transport)
    const closing = connection.closeThread("th_1")
    const unsubscribe = await nextRequest(transport)
    respond(transport, unsubscribe, { ok: true })
    await closing

    // 线程已经关掉，迟到的回放不该再交给界面。
    respond(transport, subscribe, {
      snapshot: {},
      cursor: 1,
      events: [threadEvent("th_1", 1, "run.started")],
    })
    await opening
    expect(events).toEqual([])
  })

  it("lets only the newest attach own the connection", async () => {
    const transport = new MemoryTransport()
    const statuses: string[] = []
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: (status) => statuses.push(status),
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    // 两次新端口几乎同时到达：第一次的 thread.subscribe 还没返回就被第二次取代。
    const second = new MemoryTransport()
    const secondAttach = connection.attach(second.client)
    await nextRequest(second)

    const third = new MemoryTransport()
    const thirdAttach = connection.attach(third.client)
    const thirdSubscribe = await nextRequest(third)
    respond(third, thirdSubscribe, { snapshot: {}, cursor: 0, events: [] })

    // 被取代的一次正常返回 false，不抛错；它的 subscribe 随旧连接一起被拒绝，不会卡住。
    expect(await secondAttach).toBe(false)
    expect(await thirdAttach).toBe(true)
    // 只有最后一次会报告 connected：被取代的那次不能提示「已重新连接」。
    expect(statuses).toEqual([
      "connecting",
      "connected",
      "reconnecting",
      "reconnecting",
      "connected",
    ])
  })

  it("rejects calls in flight when the host connection is replaced", async () => {
    const transport = new MemoryTransport()
    const statuses: string[] = []
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: (status) => statuses.push(status),
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    const read = connection.call("workspace.readFile", { threadId: "th_1", path: "README.md" })
    const request = await nextRequest(transport)
    expect(request.method).toBe("workspace.readFile")

    // Host 重启后 main 转交新的 MessagePort：旧连接上的读取不会再有响应。
    const resumed = new MemoryTransport()
    const attaching = connection.attach(resumed.client)
    const subscribe = await nextRequest(resumed)
    respond(resumed, subscribe, { snapshot: {}, cursor: 0, events: [] })
    await attaching

    await expect(read).rejects.toMatchObject({ code: "CONNECTION_CLOSED" })
    expect(statuses).toEqual(["connecting", "connected", "reconnecting", "connected"])
  })

  it("drops the new client when re-subscribing fails", async () => {
    const transport = new MemoryTransport()
    const statuses: string[] = []
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: (status) => statuses.push(status),
    })
    await connection.attach(transport.client)
    await open(connection, transport, "th_1")

    const broken = new MemoryTransport()
    const attaching = connection.attach(broken.client)
    const subscribe = await nextRequest(broken)
    broken.host.send({
      jsonrpc: "2.0",
      id: subscribe.id,
      error: { code: "COMMAND_FAILED", message: "host is shutting down" },
    })

    await expect(attaching).rejects.toMatchObject({ message: "host is shutting down" })
    // 失败的连接不能留下来让下一次调用发进死端口。
    await expect(connection.call("project.list", {})).rejects.toThrow("host not connected")
    expect(statuses).toEqual(["connecting", "connected", "reconnecting"])
  })
})
