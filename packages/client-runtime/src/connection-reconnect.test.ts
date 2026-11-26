/** 验证连接在重连、并发 attach、迟到回放与失败恢复场景下的行为。 */
import { describe, expect, it } from "vitest"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { Connection } from "./connection"
import { nextRequest, open, respond, threadEvent } from "./connection-test-helpers"

describe("Connection reconnect and races", () => {
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

  it("notifies onReconnect only when replacing an existing transport", async () => {
    let reconnects = 0
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
    })
    const off = connection.onReconnect(() => {
      reconnects += 1
    })

    const first = new MemoryTransport()
    await connection.attach(first.client)
    expect(reconnects).toBe(0)

    const second = new MemoryTransport()
    await connection.attach(second.client)
    expect(reconnects).toBe(1)

    off()
    const third = new MemoryTransport()
    await connection.attach(third.client)
    expect(reconnects).toBe(1)
  })
})
