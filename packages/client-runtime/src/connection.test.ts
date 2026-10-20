/** 验证连接从 snapshot/cursor 恢复线程事件。 */
import { describe, expect, it } from "vitest"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { Connection } from "./connection"

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
})
