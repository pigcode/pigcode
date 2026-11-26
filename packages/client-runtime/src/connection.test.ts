/** 验证连接从 snapshot/cursor 恢复线程事件，并维护每线程订阅。 */
import { describe, expect, it } from "vitest"
import type { TerminalOutput, Thread, ThreadEvent } from "@pigcode/contracts"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { Connection } from "./connection"
import { nextRequest, open, respond, threadEvent } from "./connection-test-helpers"

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
    const outputs: TerminalOutput[] = []
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
    transport.host.send({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: "term_1", data: " world", cursor: 11 },
    })
    expect(outputs).toEqual([
      { terminalId: "term_1", data: "hello" },
      { terminalId: "term_1", data: " world", cursor: 11 },
    ])
    off()
    transport.host.send({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: "term_1", data: "ignored", cursor: 18 },
    })
    expect(outputs).toHaveLength(2)
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

  it("hands over the thread records the Host pushes and drops malformed ones", async () => {
    const transport = new MemoryTransport()
    const changed: Thread[] = []
    const connection = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: () => {},
      onThreadChanged: (thread) => changed.push(thread),
    })
    await connection.attach(transport.client)
    const thread = {
      id: "th_1",
      projectId: "p1",
      title: "Thread",
      defaultAgentId: "fake",
      lastAgentId: null,
      lastModelId: null,
      permissionMode: "workspace-write",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      archivedAt: null,
      lastRunId: null,
      status: "completed",
      unread: true,
    }
    transport.host.send({ jsonrpc: "2.0", method: "thread.changed", params: thread })
    transport.host.send({ jsonrpc: "2.0", method: "thread.changed", params: { id: "broken" } })
    expect(changed).toEqual([expect.objectContaining({ id: "th_1", unread: true })])
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
})
